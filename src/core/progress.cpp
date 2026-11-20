#include "progress.hpp"

#include "crypto.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <format>

namespace acm {

namespace {

namespace fs = std::filesystem;

json nullable(const std::optional<std::string>& value) {
    return value ? json(*value) : json(nullptr);
}

json nullable(const std::optional<std::int64_t>& value) {
    return value ? json(*value) : json(nullptr);
}

fs::path from_utf8(const std::string& text) {
    return fs::path(std::u8string(text.begin(), text.end()));
}

std::string to_utf8(const fs::path& path) {
    const auto text = path.generic_u8string();
    return std::string(text.begin(), text.end());
}

struct ResolvedFile {
    fs::path absolute;
    std::string relative;  // normalized, forward slashes, relative to the project root
};

// Resolves `relative_path` under `root_path` and proves the real target stays
// inside the root: links are followed and a different drive never matches.
ResolvedFile resolve_in_project(const std::optional<std::string>& root_path, const std::string& relative_path) {
    if (!root_path || root_path->empty()) {
        fail("PROJECT_ROOT_UNSET", "this project has no root directory, so file references cannot be verified");
    }
    const fs::path requested = from_utf8(relative_path);
    if (requested.is_absolute() || requested.has_root_name() || requested.has_root_directory()) {
        fail("PATH_NOT_RELATIVE", "relative_path must be relative to the project root",
             {{"relative_path", relative_path}});
    }
    std::error_code error;
    const fs::path root = fs::weakly_canonical(from_utf8(*root_path), error);
    if (error || !fs::is_directory(root)) {
        fail("PROJECT_ROOT_UNAVAILABLE", "the project root directory is not reachable", {{"root_path", *root_path}});
    }
    const fs::path target = fs::weakly_canonical(root / requested, error);
    if (error) {
        fail("ARTIFACT_UNREACHABLE", "the path cannot be resolved: " + error.message(),
             {{"relative_path", relative_path}});
    }
    const fs::path inside = target.lexically_relative(root);
    if (inside.empty() || inside.native() == L"." || *inside.begin() == "..") {
        fail("PATH_OUTSIDE_PROJECT", "the resolved file is outside the project root",
             {{"relative_path", relative_path}});
    }
    if (!fs::is_regular_file(target, error)) {
        fail("ARTIFACT_UNREACHABLE", "no regular file exists at this path", {{"relative_path", relative_path}});
    }
    return {target, to_utf8(inside)};
}

std::string lowercase(std::string text) {
    std::ranges::transform(text, text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

}  // namespace

json Progress::report_progress(const Session& session, const json& args) {
    Draft draft;
    draft.kind = "progress";
    draft.conversation_id = require_string(args, "conversation_id", 96);
    draft.body = require_string(args, "summary", 4000);
    draft.recipient_session_ids = optional_string_list(args, "recipient_session_ids");
    draft.idempotency_key = require_string(args, "idempotency_key", 128);
    const auto stage = require_string(args, "stage", 128);
    const auto run_state = require_string(args, "run_state", 32);
    static constexpr std::string_view states[] = {"running", "waiting", "completed", "failed", "cancelled"};
    if (std::ranges::find(states, run_state) == std::end(states)) {
        fail("INVALID_ARGUMENT", "run_state must be running, waiting, completed, failed or cancelled");
    }
    std::optional<double> percent;
    if (args.contains("percent") && !args.at("percent").is_null()) {
        if (!args.at("percent").is_number() || args.at("percent").get<double>() < 0.0 ||
            args.at("percent").get<double>() > 100.0) {
            fail("INVALID_ARGUMENT", "percent must be a number from 0 to 100, or omitted when it is not measurable");
        }
        percent = args.at("percent").get<double>();
    }
    const auto count_done = optional_integer(args, "count_done", 0, INT64_MAX);
    const auto count_total = optional_integer(args, "count_total", 0, INT64_MAX);
    if (count_done && count_total && *count_done > *count_total) {
        fail("INVALID_ARGUMENT", "count_done cannot exceed count_total");
    }
    const auto artifact_ids = optional_string_list(args, "artifact_ids");
    for (const auto& artifact_id : artifact_ids) {
        Statement row = database_.query("SELECT conversation_id FROM artifact_refs WHERE artifact_id = ?", artifact_id);
        if (!row.step() || row.text(0) != draft.conversation_id) {
            fail("NOT_FOUND", std::format("artifact {} does not belong to this conversation", artifact_id));
        }
    }
    draft.payload = {{"stage", stage},
                     {"run_state", run_state},
                     {"source", "agent_reported"},
                     {"percent", percent ? json(*percent) : json(nullptr)},
                     {"count_done", nullable(count_done)},
                     {"count_total", nullable(count_total)},
                     {"artifact_ids", artifact_ids}};
    const auto now = to_rfc3339(clock_());
    return messages_.submit({.session = &session}, draft, [&](const std::string& message_id) {
        database_.execute(
            "INSERT INTO progress_events (progress_id, message_id, conversation_id, session_id, stage, run_state, "
            "source, percent, count_done, count_total, summary, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 'agent_reported', ?, ?, ?, ?, ?)",
            new_id("prg"), message_id, draft.conversation_id, session.session_id, stage, run_state, percent,
            count_done, count_total, draft.body, now);
        for (const auto& artifact_id : artifact_ids) {
            database_.execute("INSERT INTO message_artifacts (message_id, artifact_id) VALUES (?, ?)", message_id,
                              artifact_id);
        }
    });
}

json Progress::publish_artifact(const Session& session, const json& args) {
    Draft draft;
    draft.kind = "artifact";
    draft.conversation_id = require_string(args, "conversation_id", 96);
    draft.recipient_session_ids = optional_string_list(args, "recipient_session_ids");
    draft.idempotency_key = require_string(args, "idempotency_key", 128);
    const auto name = require_string(args, "name", 200);
    const auto relative_path = require_string(args, "relative_path", 1024);
    const auto direction = require_string(args, "direction", 16);
    if (direction != "input" && direction != "output") {
        fail("INVALID_ARGUMENT", "direction must be input or output");
    }
    const auto format = optional_string(args, "format", 64);
    const auto claimed_sha256 = optional_string(args, "sha256", 64);
    const auto row_count = optional_integer(args, "row_count", 0, INT64_MAX);
    const auto unit = optional_string(args, "unit", 64);
    const auto timezone = optional_string(args, "timezone", 64);
    const auto summary = optional_string(args, "summary", 4000);

    // Membership is checked before the file system is touched, so a caller
    // without access learns nothing about paths under the project root.
    const Access access = conversations_.require_writer(session, draft.conversation_id);
    Statement project = database_.query("SELECT root_path FROM projects WHERE project_id = ?", access.project_id);
    project.step();
    const ResolvedFile file = resolve_in_project(project.optional_text(0), relative_path);

    const std::string sha256 = sha256_file_hex(file.absolute);
    if (claimed_sha256 && lowercase(*claimed_sha256) != sha256) {
        fail("HASH_MISMATCH", "the supplied sha256 does not match the file on disk",
             {{"expected", lowercase(*claimed_sha256)}, {"actual", sha256}, {"relative_path", file.relative}});
    }
    const auto size_bytes = static_cast<std::int64_t>(std::filesystem::file_size(file.absolute));
    const std::string artifact_id = new_id("art");
    const auto now = to_rfc3339(clock_());

    draft.body = summary.value_or(std::format("{} ({})", name, file.relative));
    // The request identity excludes derived values (digest, size, generated id).
    draft.fingerprint = {{"name", name},
                         {"relative_path", file.relative},
                         {"direction", direction},
                         {"format", nullable(format)},
                         {"claimed_sha256", nullable(claimed_sha256)},
                         {"row_count", nullable(row_count)},
                         {"unit", nullable(unit)},
                         {"timezone", nullable(timezone)}};
    draft.payload = {{"artifact_id", artifact_id},
                     {"name", name},
                     {"relative_path", file.relative},
                     {"direction", direction},
                     {"format", nullable(format)},
                     {"sha256", sha256},
                     {"size_bytes", size_bytes},
                     {"row_count", nullable(row_count)},
                     {"unit", nullable(unit)},
                     {"timezone", nullable(timezone)}};
    return messages_.submit({.session = &session}, draft, [&](const std::string& message_id) {
        Statement prior = database_.query(
            "SELECT COALESCE(MAX(version), 0) FROM artifact_refs WHERE conversation_id = ? AND relative_path = ?",
            draft.conversation_id, file.relative);
        prior.step();
        database_.execute(
            "INSERT INTO artifact_refs (artifact_id, conversation_id, project_id, publisher_session_id, message_id, "
            "name, format, direction, relative_path, sha256, size_bytes, row_count, unit, timezone, summary, version, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            artifact_id, draft.conversation_id, access.project_id, session.session_id, message_id, name, format,
            direction, file.relative, sha256, size_bytes, row_count, unit, timezone, summary, prior.integer(0) + 1,
            now);
        database_.execute("INSERT INTO message_artifacts (message_id, artifact_id) VALUES (?, ?)", message_id,
                          artifact_id);
    });
}

json Progress::get_artifact(const Session& session, const json& args) {
    const auto artifact_id = require_string(args, "artifact_id", 96);
    Statement row = database_.query(
        "SELECT a.conversation_id, m.directed, m.sender_session_id, a.message_id FROM artifact_refs a "
        "JOIN messages m ON m.message_id = a.message_id WHERE a.artifact_id = ?",
        artifact_id);
    const auto hidden = [&] {
        fail("NOT_FOUND", std::format("artifact {} does not exist or is not visible to this session", artifact_id));
    };
    if (!row.step()) {
        hidden();
    }
    const auto conversation_id = row.text(0);
    const bool directed = row.integer(1) != 0;
    const bool is_publisher = row.optional_text(2) == std::optional<std::string>(session.session_id);
    const auto message_id = row.text(3);
    const Access access = conversations_.require_reader(session, conversation_id);
    if (directed && !is_publisher &&
        !database_.query("SELECT 1 FROM message_recipients WHERE message_id = ? AND session_id = ?", message_id,
                         session.session_id)
             .step()) {
        hidden();
    }

    json artifact = artifact_row(artifact_id);
    Statement project = database_.query("SELECT root_path FROM projects WHERE project_id = ?", access.project_id);
    project.step();
    // Report what is on disk now; the stored digest is the published truth.
    json current = {{"reachable", false}, {"matches_recorded_sha256", false}, {"absolute_path", nullptr}};
    try {
        const ResolvedFile file =
            resolve_in_project(project.optional_text(0), artifact.at("relative_path").get<std::string>());
        current["reachable"] = true;
        current["absolute_path"] = to_utf8(file.absolute);
        current["matches_recorded_sha256"] = sha256_file_hex(file.absolute) == artifact.at("sha256").get<std::string>();
    } catch (const ControlError& error) {
        current["reason"] = error.code();
    }
    artifact["current"] = current;
    return artifact;
}

json Progress::list_artifacts(std::string_view conversation_id) {
    std::vector<std::string> ids;
    Statement rows = database_.query(
        "SELECT artifact_id FROM artifact_refs WHERE conversation_id = ? ORDER BY created_at, artifact_id",
        conversation_id);
    while (rows.step()) {
        ids.push_back(rows.text(0));
    }
    json artifacts = json::array();
    for (const auto& id : ids) {
        artifacts.push_back(artifact_row(id));
    }
    return artifacts;
}

json Progress::artifact_row(std::string_view artifact_id) {
    Statement row = database_.query(
        "SELECT artifact_id, conversation_id, publisher_session_id, message_id, name, format, direction, "
        "relative_path, sha256, size_bytes, row_count, unit, timezone, summary, version, created_at "
        "FROM artifact_refs WHERE artifact_id = ?",
        artifact_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("artifact {} does not exist", artifact_id));
    }
    return {{"artifact_id", row.text(0)},
            {"conversation_id", row.text(1)},
            {"publisher_session_id", row.text(2)},
            {"message_id", row.text(3)},
            {"name", row.text(4)},
            {"format", nullable(row.optional_text(5))},
            {"direction", row.text(6)},
            {"relative_path", row.text(7)},
            {"sha256", row.text(8)},
            {"size_bytes", row.integer(9)},
            {"row_count", nullable(row.optional_integer(10))},
            {"unit", nullable(row.optional_text(11))},
            {"timezone", nullable(row.optional_text(12))},
            {"summary", nullable(row.optional_text(13))},
            {"version", row.integer(14)},
            {"created_at", row.text(15)}};
}

}  // namespace acm
