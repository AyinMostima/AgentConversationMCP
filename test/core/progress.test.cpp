// Tests for src/core/progress: progress reports and artifact references,
// including Windows path containment, digests and visibility.
#include "core/progress.hpp"
#include "test_support.hpp"

#include <catch2/catch_test_macros.hpp>

#include <cctype>
#include <cstdlib>
#include <fstream>

using acm::json;
using acm_test::error_code;
namespace fs = std::filesystem;

namespace {

std::string utf8(const char8_t* text) {
    return std::string(reinterpret_cast<const char*>(text));
}

fs::path native(const std::string& utf8_text) {
    return fs::path(std::u8string(utf8_text.begin(), utf8_text.end()));
}

void write_file(const fs::path& file, const std::string& content) {
    fs::create_directories(file.parent_path());
    std::ofstream(file, std::ios::binary) << content;
}

// A project directory with a file outside it, removed when the test ends.
class TempTree {
public:
    TempTree() : base_(fs::temp_directory_path() / ("acm-tree-" + acm::random_hex(8))) {
        fs::create_directories(root());
        fs::create_directories(outside());
    }
    TempTree(const TempTree&) = delete;
    TempTree& operator=(const TempTree&) = delete;
    ~TempTree() {
        std::error_code ignored;
        fs::remove_all(base_, ignored);
    }
    fs::path root() const { return base_ / "project root"; }
    fs::path outside() const { return base_ / "outside"; }
    std::string root_utf8() const {
        const auto text = root().u8string();
        return std::string(text.begin(), text.end());
    }

private:
    fs::path base_;
};

const std::string kCsv = "device,time_utc,value\nA1,2026-07-01T01:00:00Z,3.5\nB2,2026-07-01T02:00:00Z,4.1\n";

struct Fixture {
    TempTree tree;
    acm_test::TempStore store;
    acm_test::FakeClock time;
    acm::Database database{store.path()};
    acm::EventLog events{database, time.clock()};
    acm::Identity identity{database, events, time.clock()};
    acm::Conversations conversations{database, events, time.clock()};
    acm::Messages messages{database, events, conversations, time.clock()};
    acm::Progress progress{database, conversations, messages, time.clock()};
    acm::Session claude;
    acm::Session codex_one;
    acm::Session codex_two;
    acm::Session read_only;
    acm::Session outsider;
    std::string conversation;

    Fixture() {
        conversations.create_project({{"project_id", "prj_alpha"}, {"name", "Alpha"}, {"root_path", tree.root_utf8()}});
        conversations.create_project({{"project_id", "prj_rootless"}, {"name", "No root"}});
        identity.create_agent({{"agent_id", "agt"}, {"provider", "test"}, {"client_kind", "test"}, {"display_name", "T"}});
        claude = active("claude");
        codex_one = active("codex window 1");
        codex_two = active("codex window 2");
        read_only = active("read only");
        outsider = active("outsider");
        conversation = conversations
                           .create_conversation({{"project_id", "prj_alpha"}, {"task_code", "DATA-014"}, {"title", "t"}})
                           .at("conversation_id");
        conversations.set_members(
            conversation,
            {{"expected_version", 1},
             {"members",
              {{{"session_id", claude.session_id}},
               {{"session_id", codex_one.session_id}},
               {{"session_id", codex_two.session_id}},
               {{"session_id", read_only.session_id}, {"can_write", false}}}}});
        write_file(tree.root() / "out" / "clean.csv", kCsv);
    }

    acm::Session active(const std::string& label, const std::string& project_id = "prj_alpha") {
        const json pairing = identity.create_pairing({{"agent_id", "agt"}, {"project_id", project_id}, {"label", label}});
        const std::string token = pairing.at("token");
        identity.request_pairing(identity.authenticate(token), {{"client_kind", "test"}});
        identity.approve_pairing(pairing.at("session_id").get<std::string>());
        return identity.authenticate(token);
    }

    json publish(const acm::Session& as, const std::string& relative_path, const std::string& key,
                 json extra = json::object()) {
        json args = {{"conversation_id", conversation},
                     {"name", "clean readings"},
                     {"relative_path", relative_path},
                     {"direction", "output"},
                     {"idempotency_key", key}};
        args.update(extra);
        return progress.publish_artifact(as, args);
    }

    std::int64_t count(const char* table) {
        acm::Statement row = database.query(std::string("SELECT COUNT(*) FROM ") + table);
        row.step();
        return row.integer(0);
    }
};

}  // namespace

TEST_CASE("publishing an artifact records a verified reference on the timeline", "[progress][artifact]") {
    Fixture f;
    const json posted = f.publish(f.claude, "out\\clean.csv", "art-1",
                                  {{"format", "csv"},
                                   {"row_count", 2},
                                   {"unit", "ug/m3"},
                                   {"timezone", "UTC"},
                                   {"summary", "12 -> 8 rows, UTC"}});
    REQUIRE(posted.at("kind") == "artifact");
    REQUIRE(posted.at("body") == "12 -> 8 rows, UTC");
    const json& payload = posted.at("payload");
    REQUIRE(payload.at("relative_path") == "out/clean.csv");
    REQUIRE(payload.at("sha256") == acm::sha256_hex(kCsv));
    REQUIRE(payload.at("size_bytes") == static_cast<std::int64_t>(kCsv.size()));
    REQUIRE(payload.at("row_count") == 2);
    REQUIRE(payload.at("timezone") == "UTC");

    // The receiving session reads the same reference and can verify the file independently.
    const json page = f.messages.read(f.codex_one, {{"conversation_id", f.conversation}});
    const std::string artifact_id = page.at("messages").at(0).at("payload").at("artifact_id");
    const json artifact = f.progress.get_artifact(f.codex_one, {{"artifact_id", artifact_id}});
    REQUIRE(artifact.at("version") == 1);
    REQUIRE(artifact.at("publisher_session_id") == f.claude.session_id);
    REQUIRE(artifact.at("current").at("reachable") == true);
    REQUIRE(artifact.at("current").at("matches_recorded_sha256") == true);
    const fs::path resolved = native(artifact.at("current").at("absolute_path").get<std::string>());
    REQUIRE(acm::sha256_file_hex(resolved) == artifact.at("sha256").get<std::string>());
    REQUIRE(f.progress.list_artifacts(f.conversation).size() == 1);
}

TEST_CASE("paths with Chinese characters and spaces are accepted and normalized", "[progress][paths]") {
    Fixture f;
    const std::string folder = utf8(u8"\u6570\u636e \u8f93\u51fa");
    const std::string file_name = utf8(u8"\u7ed3\u679c \u8868.csv");
    write_file(f.tree.root() / native(folder) / native(file_name), kCsv);

    const json posted = f.publish(f.claude, folder + "\\" + file_name, "art-cn");
    REQUIRE(posted.at("payload").at("relative_path") == folder + "/" + file_name);
    REQUIRE(posted.at("payload").at("sha256") == acm::sha256_hex(kCsv));
    const std::string artifact_id = posted.at("payload").at("artifact_id");
    const json artifact = f.progress.get_artifact(f.codex_two, {{"artifact_id", artifact_id}});
    REQUIRE(artifact.at("current").at("matches_recorded_sha256") == true);
    // A redundant path that stays inside the root is normalized, not rejected.
    REQUIRE(f.publish(f.claude, "out\\..\\out\\.\\clean.csv", "art-dots").at("payload").at("relative_path") ==
            "out/clean.csv");
}

TEST_CASE("references outside the project, missing files and wrong digests are refused with a reason",
          "[progress][paths]") {
    Fixture f;
    write_file(f.tree.outside() / "secret.txt", "not part of the project");
    fs::create_directories(f.tree.root() / "empty-dir");

    REQUIRE(error_code([&] { f.publish(f.claude, "..\\outside\\secret.txt", "bad-1"); }) == "PATH_OUTSIDE_PROJECT");
    REQUIRE(error_code([&] { f.publish(f.claude, "out\\..\\..\\outside\\secret.txt", "bad-2"); }) ==
            "PATH_OUTSIDE_PROJECT");
    REQUIRE(error_code([&] { f.publish(f.claude, "C:\\Windows\\win.ini", "bad-3"); }) == "PATH_NOT_RELATIVE");
    REQUIRE(error_code([&] { f.publish(f.claude, "\\Windows\\win.ini", "bad-4"); }) == "PATH_NOT_RELATIVE");
    REQUIRE(error_code([&] { f.publish(f.claude, "out\\missing.csv", "bad-5"); }) == "ARTIFACT_UNREACHABLE");
    REQUIRE(error_code([&] { f.publish(f.claude, "empty-dir", "bad-6"); }) == "ARTIFACT_UNREACHABLE");
    REQUIRE(error_code([&] { f.publish(f.claude, ".", "bad-7"); }) == "PATH_OUTSIDE_PROJECT");

    // A junction inside the root that points outside is judged by its real target.
    const std::string command = "cmd /c mklink /J \"" + (f.tree.root() / "link").string() + "\" \"" +
                                f.tree.outside().string() + "\" >NUL 2>&1";
    REQUIRE(std::system(command.c_str()) == 0);
    REQUIRE(error_code([&] { f.publish(f.claude, "link\\secret.txt", "bad-8"); }) == "PATH_OUTSIDE_PROJECT");

    try {
        f.publish(f.claude, "out\\clean.csv", "bad-9", {{"sha256", std::string(64, '0')}});
        FAIL("expected HASH_MISMATCH");
    } catch (const acm::ControlError& error) {
        REQUIRE(error.code() == "HASH_MISMATCH");
        REQUIRE(error.details().at("actual") == acm::sha256_hex(kCsv));
    }
    // An uppercase digest of the right content is accepted.
    std::string upper = acm::sha256_hex(kCsv);
    for (auto& c : upper) {
        c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    }
    REQUIRE_NOTHROW(f.publish(f.claude, "out\\clean.csv", "good-1", {{"sha256", upper}}));
    REQUIRE(f.count("artifact_refs") == 1);
    REQUIRE(f.count("messages") == 1);
}

TEST_CASE("a project without a root directory cannot hold file references", "[progress][paths]") {
    Fixture f;
    const auto rootless = f.active("rootless", "prj_rootless");
    const std::string id = f.conversations
                               .create_conversation({{"project_id", "prj_rootless"}, {"task_code", "X-1"}, {"title", "t"}})
                               .at("conversation_id");
    f.conversations.set_members(id, {{"expected_version", 1}, {"members", {{{"session_id", rootless.session_id}}}}});
    REQUIRE(error_code([&] {
                f.progress.publish_artifact(rootless, {{"conversation_id", id},
                                                       {"name", "n"},
                                                       {"relative_path", "a.csv"},
                                                       {"direction", "output"},
                                                       {"idempotency_key", "k"}});
            }) == "PROJECT_ROOT_UNSET");
}

TEST_CASE("artifact access follows membership and the visibility of its message", "[progress][permissions]") {
    Fixture f;
    // Membership is decided before any path is examined.
    REQUIRE(error_code([&] { f.publish(f.outsider, "out\\clean.csv", "p-1"); }) == "NOT_MEMBER");
    REQUIRE(error_code([&] { f.publish(f.outsider, "out\\does-not-exist.csv", "p-2"); }) == "NOT_MEMBER");
    REQUIRE(error_code([&] { f.publish(f.read_only, "out\\clean.csv", "p-3"); }) == "WRITE_DENIED");

    const json directed =
        f.publish(f.claude, "out\\clean.csv", "p-4", {{"recipient_session_ids", {f.codex_one.session_id}}});
    const std::string artifact_id = directed.at("payload").at("artifact_id");
    REQUIRE_NOTHROW(f.progress.get_artifact(f.codex_one, {{"artifact_id", artifact_id}}));
    REQUIRE_NOTHROW(f.progress.get_artifact(f.claude, {{"artifact_id", artifact_id}}));
    REQUIRE(error_code([&] { f.progress.get_artifact(f.codex_two, {{"artifact_id", artifact_id}}); }) == "NOT_FOUND");
    REQUIRE(error_code([&] { f.progress.get_artifact(f.outsider, {{"artifact_id", artifact_id}}); }) == "NOT_MEMBER");
    REQUIRE(error_code([&] { f.progress.get_artifact(f.codex_one, {{"artifact_id", "art_missing"}}); }) == "NOT_FOUND");
    REQUIRE(f.messages.read(f.codex_two, {{"conversation_id", f.conversation}}).at("messages").empty());
}

TEST_CASE("republishing is idempotent per key and versions a changed file", "[progress][versions]") {
    Fixture f;
    const json first = f.publish(f.claude, "out\\clean.csv", "v-1");
    const std::string first_id = first.at("payload").at("artifact_id");

    // The file changes, then the original request is retried: still the original reference.
    write_file(f.tree.root() / "out" / "clean.csv", kCsv + "C3,2026-07-01T03:00:00Z,5.0\n");
    const json retry = f.publish(f.claude, "out\\clean.csv", "v-1");
    REQUIRE(retry.at("idempotent_replay") == true);
    REQUIRE(retry.at("message_id") == first.at("message_id"));
    REQUIRE(retry.at("payload").at("sha256") == acm::sha256_hex(kCsv));
    REQUIRE(f.count("artifact_refs") == 1);
    REQUIRE(error_code([&] { f.publish(f.claude, "out\\clean.csv", "v-1", {{"name", "renamed"}}); }) ==
            "IDEMPOTENCY_CONFLICT");

    // A reader of version 1 is told the file no longer matches what was published.
    const json stale = f.progress.get_artifact(f.codex_one, {{"artifact_id", first_id}});
    REQUIRE(stale.at("current").at("reachable") == true);
    REQUIRE(stale.at("current").at("matches_recorded_sha256") == false);

    const json second = f.publish(f.claude, "out\\clean.csv", "v-2");
    const std::string second_id = second.at("payload").at("artifact_id");
    const json current = f.progress.get_artifact(f.codex_one, {{"artifact_id", second_id}});
    REQUIRE(current.at("version") == 2);
    REQUIRE(current.at("sha256") != stale.at("sha256"));
    REQUIRE(current.at("current").at("matches_recorded_sha256") == true);

    // Deleting the file is reported, not hidden.
    fs::remove(f.tree.root() / "out" / "clean.csv");
    const json gone = f.progress.get_artifact(f.codex_one, {{"artifact_id", second_id}});
    REQUIRE(gone.at("current").at("reachable") == false);
    REQUIRE(gone.at("current").at("reason") == "ARTIFACT_UNREACHABLE");
}

TEST_CASE("progress reports keep the reported values and their source", "[progress][report]") {
    Fixture f;
    const json artifact = f.publish(f.claude, "out\\clean.csv", "pr-art");
    const std::string artifact_id = artifact.at("payload").at("artifact_id");

    const json report = f.progress.report_progress(
        f.claude, {{"conversation_id", f.conversation},
                   {"stage", "dedupe"},
                   {"run_state", "running"},
                   {"summary", "removed 4 of 12 rows"},
                   {"percent", 66.5},
                   {"count_done", 8},
                   {"count_total", 12},
                   {"artifact_ids", {artifact_id}},
                   // A model cannot upgrade its own report to a measurement.
                   {"source", "command_measured"},
                   {"idempotency_key", "pr-1"}});
    REQUIRE(report.at("kind") == "progress");
    REQUIRE(report.at("sequence") == 2);
    REQUIRE(report.at("body") == "removed 4 of 12 rows");
    REQUIRE(report.at("payload").at("source") == "agent_reported");
    REQUIRE(report.at("payload").at("percent") == 66.5);
    REQUIRE(report.at("payload").at("artifact_ids").at(0) == artifact_id);

    // Unmeasurable progress is stored as null, not as a guess.
    const json unknown = f.progress.report_progress(f.codex_one, {{"conversation_id", f.conversation},
                                                                  {"stage", "verify"},
                                                                  {"run_state", "waiting"},
                                                                  {"summary", "waiting for input"},
                                                                  {"idempotency_key", "pr-2"}});
    REQUIRE(unknown.at("payload").at("percent").is_null());
    REQUIRE(unknown.at("payload").at("count_total").is_null());

    acm::Statement row = f.database.query(
        "SELECT stage, run_state, source, percent, count_done, count_total FROM progress_events ORDER BY created_at, "
        "stage");
    REQUIRE(row.step());
    REQUIRE(row.text(0) == "dedupe");
    REQUIRE(row.text(2) == "agent_reported");
    REQUIRE(row.optional_real(3) == std::optional<double>(66.5));
    REQUIRE(row.integer(5) == 12);
    REQUIRE(f.count("progress_events") == 2);
    REQUIRE(f.count("message_artifacts") == 2);

    // The report is part of the same timeline the other members read.
    const json page = f.messages.read(f.codex_two, {{"conversation_id", f.conversation}});
    REQUIRE(page.at("messages").size() == 3);
    REQUIRE(page.at("messages").at(1).at("payload").at("stage") == "dedupe");

    const json replay = f.progress.report_progress(
        f.claude, {{"conversation_id", f.conversation},
                   {"stage", "dedupe"},
                   {"run_state", "running"},
                   {"summary", "removed 4 of 12 rows"},
                   {"percent", 66.5},
                   {"count_done", 8},
                   {"count_total", 12},
                   {"artifact_ids", {artifact_id}},
                   {"idempotency_key", "pr-1"}});
    REQUIRE(replay.at("idempotent_replay") == true);
    REQUIRE(f.count("progress_events") == 2);
}

TEST_CASE("invalid progress input and permission failures store nothing", "[progress][validation]") {
    Fixture f;
    const auto report = [&](const acm::Session& as, json extra) {
        json args = {{"conversation_id", f.conversation},
                     {"stage", "s"},
                     {"run_state", "running"},
                     {"summary", "x"},
                     {"idempotency_key", "bad-" + acm::random_hex(4)}};
        args.update(extra);
        return f.progress.report_progress(as, args);
    };
    REQUIRE(error_code([&] { report(f.claude, {{"percent", 101}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { report(f.claude, {{"percent", "half"}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { report(f.claude, {{"run_state", "almost"}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { report(f.claude, {{"count_done", 9}, {"count_total", 8}}); }) == "INVALID_ARGUMENT");
    REQUIRE(error_code([&] { report(f.claude, {{"artifact_ids", {"art_missing"}}}); }) == "NOT_FOUND");
    REQUIRE(error_code([&] { report(f.read_only, json::object()); }) == "WRITE_DENIED");
    REQUIRE(error_code([&] { report(f.outsider, json::object()); }) == "NOT_MEMBER");
    REQUIRE(f.count("progress_events") == 0);
    REQUIRE(f.count("messages") == 0);
}
