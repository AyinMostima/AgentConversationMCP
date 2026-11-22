#include "identity.hpp"

#include "crypto.hpp"
#include "settings.hpp"

#include <algorithm>
#include <format>

namespace acm {

namespace {

constexpr std::int64_t kDefaultPairingTtlSeconds = 15 * 60;
constexpr std::int64_t kMaxPairingTtlSeconds = 24 * 60 * 60;

json nullable(const std::optional<std::string>& value) {
    return value ? json(*value) : json(nullptr);
}

// The project self-enrolled sessions land in unless the bridge names another.
constexpr std::string_view kDefaultProjectId = "prj_default";

struct ClientPreset {
    std::string agent_id;
    std::string provider;
    std::string client_kind;
    std::string display_name;
};

// The four desktop clients map to their logical agents; anything else gets an
// agent of its own, named after what the bridge was told it is.
ClientPreset preset_for(const std::string& client) {
    if (client == "claude") {
        return {"agt_claude", "anthropic", "claude-desktop", "Claude"};
    }
    if (client == "codex") {
        return {"agt_codex", "openai", "codex-desktop", "Codex"};
    }
    if (client == "antigravity") {
        return {"agt_antigravity", "google", "antigravity", "Antigravity"};
    }
    if (client == "grok") {
        return {"agt_grok", "xai", "grok-bot", "Grok Bot"};
    }
    return {"agt_" + client, "other", client, client};
}

bool is_client_name(const std::string& text) {
    return !text.empty() && std::ranges::all_of(text, [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
    });
}

// A self-issued credential must carry as much entropy as an issued one.
bool is_session_token(std::string_view token) {
    constexpr std::string_view prefix = "acm_";
    return token.size() == prefix.size() + 48 && token.starts_with(prefix) &&
           std::ranges::all_of(token.substr(prefix.size()), [](char c) {
               return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
           });
}

}  // namespace

json Identity::create_agent(const json& args) {
    const auto agent_id = optional_string(args, "agent_id", 96).value_or(new_id("agt"));
    const auto provider = require_string(args, "provider", 64);
    const auto client_kind = require_string(args, "client_kind", 64);
    const auto display_name = require_string(args, "display_name", 128);
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        Statement existing = database_.query("SELECT 1 FROM agents WHERE agent_id = ?", agent_id);
        if (existing.step()) {
            fail("ALREADY_EXISTS", std::format("agent {} already exists", agent_id));
        }
        database_.execute(
            "INSERT INTO agents (agent_id, provider, client_kind, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
            agent_id, provider, client_kind, display_name, now);
        json agent = {{"agent_id", agent_id},
                      {"provider", provider},
                      {"client_kind", client_kind},
                      {"display_name", display_name},
                      {"created_at", now}};
        events_.append("agent.created", {}, agent_id, agent);
        return agent;
    });
}

json Identity::update_agent(std::string_view agent_id, const json& args) {
    const auto display_name = require_string(args, "display_name", 64);
    return database_.transaction([&] {
        Statement row = database_.query("SELECT provider, client_kind, created_at FROM agents WHERE agent_id = ?", agent_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("agent {} does not exist", agent_id));
        }
        json agent = {{"agent_id", agent_id},
                      {"provider", row.text(0)},
                      {"client_kind", row.text(1)},
                      {"display_name", display_name},
                      {"created_at", row.text(2)}};
        database_.execute("UPDATE agents SET display_name = ? WHERE agent_id = ?", display_name, agent_id);
        events_.append("agent.updated", {}, agent_id, {{"agent_id", agent_id}, {"display_name", display_name}});
        return agent;
    });
}

json Identity::create_pairing(const json& args) {
    const auto agent_id = require_string(args, "agent_id", 96);
    const auto project_id = require_string(args, "project_id", 96);
    const auto label = require_string(args, "label", 128);
    const auto ttl = optional_integer(args, "ttl_seconds", kDefaultPairingTtlSeconds, 1, kMaxPairingTtlSeconds);
    const auto now = clock_();
    const auto session_id = new_id("ses");
    const auto token = "acm_" + random_hex(24);
    const auto expires_at = to_rfc3339(now + std::chrono::seconds(ttl));
    return database_.transaction([&] {
        if (!database_.query("SELECT 1 FROM agents WHERE agent_id = ?", agent_id).step()) {
            fail("NOT_FOUND", std::format("agent {} does not exist", agent_id));
        }
        if (!database_.query("SELECT 1 FROM projects WHERE project_id = ?", project_id).step()) {
            fail("NOT_FOUND", std::format("project {} does not exist", project_id));
        }
        database_.execute(
            "INSERT INTO agent_sessions (session_id, agent_id, project_id, label, token_hash, status, "
            "pairing_expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
            session_id, agent_id, project_id, label, sha256_hex(token), expires_at, to_rfc3339(now));
        events_.append("pairing.created", {.project_id = project_id}, session_id,
                       {{"session_id", session_id}, {"agent_id", agent_id}, {"pairing_expires_at", expires_at}});
        json pairing = session_row(session_id);
        pairing["token"] = token;
        return pairing;
    });
}

Session Identity::authenticate(std::string_view token) {
    if (token.empty()) {
        fail("UNAUTHENTICATED", "a session credential is required");
    }
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        Statement row = database_.query(
            "SELECT session_id, agent_id, project_id, label, status, binding_version, pairing_expires_at, linked, "
            "rate_exempt "
            "FROM agent_sessions WHERE token_hash = ?",
            sha256_hex(token));
        if (!row.step()) {
            fail("UNAUTHENTICATED", "the session credential is not recognized");
        }
        Session session{row.text(0), row.text(1), row.text(2), row.text(3), row.text(4), row.integer(5)};
        session.linked = row.integer(7) != 0;
        session.rate_exempt = row.integer(8) != 0;
        const auto expires_at = row.text(6);
        if (session.status == "revoked") {
            fail("SESSION_REVOKED", std::format("session {} was revoked by the operator", session.session_id),
                 {{"session_id", session.session_id}});
        }
        if ((session.status == "pending" || session.status == "requested") && expires_at < now) {
            database_.execute("UPDATE agent_sessions SET status = 'expired' WHERE session_id = ?",
                              session.session_id);
            events_.append("pairing.expired", {.project_id = session.project_id}, session.session_id,
                           {{"session_id", session.session_id}});
            session.status = "expired";
        }
        database_.execute("UPDATE agent_sessions SET last_seen_at = ? WHERE session_id = ?", now,
                          session.session_id);
        return session;
    });
}

json Identity::request_pairing(const Session& session, const json& args) {
    const auto client_kind = require_string(args, "client_kind", 64);
    const auto cwd = optional_string(args, "cwd", 1024);
    const auto run_id = optional_string(args, "run_id", 256);
    const auto external_session_id = optional_string(args, "external_session_id", 256);
    if (session.status == "expired") {
        fail("PAIRING_EXPIRED", "this pairing expired before it was completed; ask the operator for a new one");
    }
    if (session.status == "active") {
        return session_row(session.session_id);
    }
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        // With interconnection on, presenting an issued credential and reporting
        // the instance is enough: the pairing is approved at once.
        const bool automatic = open_mode(database_);
        database_.execute(
            "UPDATE agent_sessions SET status = ?, claimed_client_kind = ?, claimed_cwd = ?, claimed_run_id = ?, "
            "external_session_id = ?, requested_at = ?, approved_at = ? WHERE session_id = ?",
            automatic ? "active" : "requested", client_kind, cwd, run_id, external_session_id, now,
            automatic ? std::optional<std::string>(now) : std::nullopt, session.session_id);
        events_.append("pairing.requested", {.project_id = session.project_id, .actor_id = session.session_id},
                       session.session_id,
                       {{"session_id", session.session_id},
                        {"client_kind", client_kind},
                        {"cwd", nullable(cwd)},
                        {"run_id", nullable(run_id)},
                        {"external_session_id", nullable(external_session_id)}});
        if (automatic) {
            events_.append("pairing.approved", {.project_id = session.project_id}, session.session_id,
                           {{"session_id", session.session_id}, {"automatic", true}});
        }
        return session_row(session.session_id);
    });
}

json Identity::enroll(std::string_view token, const json& args) {
    if (!is_session_token(token)) {
        fail("INVALID_ARGUMENT", "a self-issued credential must be acm_ followed by 48 lowercase hex digits");
    }
    const auto client = require_string(args, "client", 48);
    if (!is_client_name(client)) {
        fail("INVALID_ARGUMENT", "client must consist of lowercase letters, digits and dashes");
    }
    const ClientPreset preset = preset_for(client);
    const auto project_id = optional_string(args, "project_id", 96).value_or(std::string(kDefaultProjectId));
    const auto label = optional_string(args, "label", 128).value_or(preset.client_kind);
    const auto cwd = optional_string(args, "cwd", 1024);
    const auto run_id = optional_string(args, "run_id", 256);
    // How many tools the bridge offers, so an out-of-date bridge shows up as such.
    const auto bridge_tools = optional_integer(args, "bridge_tools", 0, 10000);
    // Which version of the tool contract it offers: the same number of tools can still differ in parameters.
    const auto bridge_contract = optional_integer(args, "bridge_contract", 0, 1000000);
    // Whether it takes the tool list from the service each time its client asks (then
    // the two numbers above say what the client was last given, not what the bridge carries).
    const bool bridge_relay = optional_bool(args, "bridge_relay", false);
    const auto moment = clock_();
    const auto now = to_rfc3339(moment);
    const auto expires_at = to_rfc3339(moment + std::chrono::seconds(kDefaultPairingTtlSeconds));
    const auto token_hash = sha256_hex(token);

    return database_.transaction([&] {
        std::string session_id;
        std::string status;
        std::string bound_project;
        Statement known = database_.query(
            "SELECT session_id, status, project_id FROM agent_sessions WHERE token_hash = ?", token_hash);
        if (known.step()) {
            session_id = known.text(0);
            status = known.text(1);
            bound_project = known.text(2);
            if (status == "revoked") {
                fail("SESSION_REVOKED", std::format("session {} was revoked by the operator", session_id),
                     {{"session_id", session_id}});
            }
        } else {
            if (!database_.query("SELECT 1 FROM agents WHERE agent_id = ?", preset.agent_id).step()) {
                database_.execute(
                    "INSERT INTO agents (agent_id, provider, client_kind, display_name, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    preset.agent_id, preset.provider, preset.client_kind, preset.display_name, now);
                events_.append("agent.created", {}, preset.agent_id,
                               {{"agent_id", preset.agent_id},
                                {"provider", preset.provider},
                                {"client_kind", preset.client_kind},
                                {"display_name", preset.display_name}});
            }
            if (!database_.query("SELECT 1 FROM projects WHERE project_id = ?", project_id).step()) {
                if (project_id != kDefaultProjectId) {
                    fail("NOT_FOUND", std::format("project {} does not exist", project_id));
                }
                database_.execute("INSERT INTO projects (project_id, name, created_at) VALUES (?, 'Default', ?)",
                                  project_id, now);
                events_.append("project.created", {.project_id = project_id}, project_id,
                               {{"project_id", project_id}, {"name", "Default"}});
            }
            session_id = new_id("ses");
            status = "pending";
            bound_project = project_id;
            database_.execute(
                "INSERT INTO agent_sessions (session_id, agent_id, project_id, label, token_hash, status, "
                "pairing_expires_at, created_at, rate_exempt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
                // The bot host answers for many requesters at once, so it starts without flood limits.
                session_id, preset.agent_id, project_id, label, token_hash, expires_at, now, client == "grok");
            events_.append("pairing.created", {.project_id = project_id}, session_id,
                           {{"session_id", session_id},
                            {"agent_id", preset.agent_id},
                            {"pairing_expires_at", expires_at},
                            {"self_enrolled", true}});
        }
        if (status != "active") {
            // Every start of the bridge renews the request, so an enrollment that
            // waited too long for the operator is not stuck in `expired`.
            const bool automatic = open_mode(database_);
            database_.execute(
                "UPDATE agent_sessions SET status = ?, claimed_client_kind = ?, claimed_cwd = ?, claimed_run_id = ?, "
                "requested_at = ?, approved_at = ?, pairing_expires_at = ? WHERE session_id = ?",
                automatic ? "active" : "requested", preset.client_kind, cwd, run_id, now,
                automatic ? std::optional<std::string>(now) : std::nullopt, expires_at, session_id);
            if (status != "requested") {
                events_.append("pairing.requested", {.project_id = bound_project, .actor_id = session_id},
                               session_id,
                               {{"session_id", session_id},
                                {"client_kind", preset.client_kind},
                                {"cwd", nullable(cwd)},
                                {"run_id", nullable(run_id)},
                                {"external_session_id", nullptr}});
            }
            if (automatic) {
                events_.append("pairing.approved", {.project_id = bound_project}, session_id,
                               {{"session_id", session_id}, {"automatic", true}});
            }
        }
        // Only a bridge registers itself, and it does so when it starts: what it reports
        // now replaces what an earlier start of it reported.
        database_.execute(
            "UPDATE agent_sessions SET last_seen_at = ?, self_enrolled = 1, bridge_tools = COALESCE(?, bridge_tools), "
            "bridge_contract = ?, bridge_relay = ? WHERE session_id = ?",
            now, bridge_tools, bridge_contract, static_cast<std::int64_t>(bridge_relay ? 1 : 0), session_id);
        return session_row(session_id);
    });
}

json Identity::set_rate_exempt(std::string_view session_id, bool exempt) {
    return database_.transaction([&] {
        Statement row = database_.query("SELECT project_id, rate_exempt FROM agent_sessions WHERE session_id = ?",
                                        session_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("session {} does not exist", session_id));
        }
        if ((row.integer(1) != 0) != exempt) {
            const auto project_id = row.text(0);
            database_.execute("UPDATE agent_sessions SET rate_exempt = ? WHERE session_id = ?", exempt, session_id);
            events_.append("session.limits_changed", {.project_id = project_id}, session_id,
                           {{"session_id", session_id}, {"rate_exempt", exempt}});
        }
        return session_row(session_id);
    });
}

json Identity::set_urgent_dispatch(std::string_view session_id, bool enabled) {
    return database_.transaction([&] {
        Statement row = database_.query("SELECT project_id, urgent_dispatch FROM agent_sessions WHERE session_id = ?",
                                        session_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("session {} does not exist", session_id));
        }
        if ((row.integer(1) != 0) != enabled) {
            const auto project_id = row.text(0);
            database_.execute("UPDATE agent_sessions SET urgent_dispatch = ? WHERE session_id = ?", enabled, session_id);
            events_.append("session.limits_changed", {.project_id = project_id}, session_id,
                           {{"session_id", session_id}, {"urgent_dispatch", enabled}});
        }
        return session_row(session_id);
    });
}

json Identity::approve_pairing(std::string_view session_id) {
    const auto now = to_rfc3339(clock_());
    // The transaction commits the move to `expired`; the error is raised afterwards
    // so the expiry is durable instead of being rolled back with the failure.
    const json result = database_.transaction([&] {
        Statement row = database_.query(
            "SELECT status, pairing_expires_at, project_id FROM agent_sessions WHERE session_id = ?", session_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("session {} does not exist", session_id));
        }
        const auto status = row.text(0);
        const auto project_id = row.text(2);
        if (status == "active") {
            return session_row(session_id);
        }
        if (status == "pending") {
            fail("PAIRING_NOT_REQUESTED",
                 "no client instance has requested this pairing yet; approval needs the reported instance");
        }
        if (status == "requested" && row.text(1) < now) {
            database_.execute("UPDATE agent_sessions SET status = 'expired' WHERE session_id = ?", session_id);
            events_.append("pairing.expired", {.project_id = project_id}, session_id, {{"session_id", session_id}});
            return session_row(session_id);
        }
        if (status != "requested") {
            fail("PAIRING_CLOSED", std::format("session {} is {} and cannot be approved", session_id, status));
        }
        database_.execute("UPDATE agent_sessions SET status = 'active', approved_at = ? WHERE session_id = ?", now,
                          session_id);
        events_.append("pairing.approved", {.project_id = project_id}, session_id, {{"session_id", session_id}});
        return session_row(session_id);
    });
    if (result.at("status") == "expired") {
        fail("PAIRING_EXPIRED", std::format("the pairing for session {} expired before approval", session_id));
    }
    return result;
}

json Identity::revoke_session(std::string_view session_id) {
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        Statement row = database_.query("SELECT status, project_id FROM agent_sessions WHERE session_id = ?",
                                        session_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("session {} does not exist", session_id));
        }
        if (row.text(0) != "revoked") {
            const auto project_id = row.text(1);
            database_.execute(
                "UPDATE agent_sessions SET status = 'revoked', revoked_at = ?, binding_version = binding_version + 1 "
                "WHERE session_id = ?",
                now, session_id);
            events_.append("session.revoked", {.project_id = project_id}, session_id, {{"session_id", session_id}});
        }
        return session_row(session_id);
    });
}

json Identity::set_linked(std::string_view session_id, bool linked) {
    return database_.transaction([&] {
        Statement row = database_.query("SELECT project_id, linked FROM agent_sessions WHERE session_id = ?",
                                        session_id);
        if (!row.step()) {
            fail("NOT_FOUND", std::format("session {} does not exist", session_id));
        }
        if ((row.integer(1) != 0) != linked) {
            const auto project_id = row.text(0);
            database_.execute("UPDATE agent_sessions SET linked = ? WHERE session_id = ?", linked, session_id);
            events_.append("session.link_changed", {.project_id = project_id}, session_id,
                           {{"session_id", session_id}, {"linked", linked}});
        }
        return session_row(session_id);
    });
}

void Identity::require_active(const Session& session) const {
    if (session.status == "expired") {
        fail("PAIRING_EXPIRED", "this pairing expired before it was completed; ask the operator for a new one");
    }
    if (session.status != "active") {
        fail("NOT_PAIRED",
             std::format("session {} is {}; call request_pairing and wait for operator approval",
                         session.session_id, session.status),
             {{"session_id", session.session_id}, {"status", session.status}});
    }
}

json Identity::describe(const Session& session) {
    json view = session_row(session.session_id);
    Statement agent = database_.query(
        "SELECT provider, client_kind, display_name FROM agents WHERE agent_id = ?", session.agent_id);
    agent.step();
    view["agent"] = {{"agent_id", session.agent_id},
                     {"provider", agent.text(0)},
                     {"client_kind", agent.text(1)},
                     {"display_name", agent.text(2)}};
    // P1 exposes pull-based sharing only; active-turn delivery arrives with the adapters.
    view["capabilities"] = {{"shared_read_write", view.at("status") == "active"},
                            {"steer_active", false},
                            {"start_new_turn", false}};
    return view;
}

json Identity::list_sessions() {
    json sessions = json::array();
    std::vector<std::string> ids;
    Statement rows = database_.query("SELECT session_id FROM agent_sessions ORDER BY created_at DESC, session_id");
    while (rows.step()) {
        ids.push_back(rows.text(0));
    }
    for (const auto& id : ids) {
        sessions.push_back(session_row(id));
    }
    return sessions;
}

json Identity::list_agents() {
    json agents = json::array();
    Statement rows = database_.query(
        "SELECT agent_id, provider, client_kind, display_name, created_at FROM agents ORDER BY created_at, agent_id");
    while (rows.step()) {
        agents.push_back({{"agent_id", rows.text(0)},
                          {"provider", rows.text(1)},
                          {"client_kind", rows.text(2)},
                          {"display_name", rows.text(3)},
                          {"created_at", rows.text(4)}});
    }
    return agents;
}

std::int64_t Identity::expire_stale_pairings() {
    const auto now = to_rfc3339(clock_());
    return database_.transaction([&] {
        std::vector<std::pair<std::string, std::string>> overdue;
        Statement rows = database_.query(
            "SELECT session_id, project_id FROM agent_sessions "
            "WHERE status IN ('pending', 'requested') AND pairing_expires_at < ?",
            now);
        while (rows.step()) {
            overdue.emplace_back(rows.text(0), rows.text(1));
        }
        for (const auto& [session_id, project_id] : overdue) {
            database_.execute("UPDATE agent_sessions SET status = 'expired' WHERE session_id = ?", session_id);
            events_.append("pairing.expired", {.project_id = project_id}, session_id, {{"session_id", session_id}});
        }
        return static_cast<std::int64_t>(overdue.size());
    });
}

json Identity::session_row(std::string_view session_id) {
    Statement row = database_.query(
        "SELECT session_id, agent_id, project_id, label, status, binding_version, pairing_expires_at, "
        "claimed_client_kind, claimed_cwd, claimed_run_id, external_session_id, created_at, requested_at, "
        "approved_at, revoked_at, last_seen_at, linked, rate_exempt, host_seen_at, bridge_tools, urgent_dispatch, "
        "self_enrolled, bridge_contract, bridge_relay FROM agent_sessions WHERE session_id = ?",
        session_id);
    if (!row.step()) {
        fail("NOT_FOUND", std::format("session {} does not exist", session_id));
    }
    return {{"session_id", row.text(0)},
            {"agent_id", row.text(1)},
            {"project_id", row.text(2)},
            {"label", row.text(3)},
            {"status", row.text(4)},
            {"binding_version", row.integer(5)},
            {"pairing_expires_at", row.text(6)},
            {"claimed_client_kind", nullable(row.optional_text(7))},
            {"claimed_cwd", nullable(row.optional_text(8))},
            {"claimed_run_id", nullable(row.optional_text(9))},
            {"external_session_id", nullable(row.optional_text(10))},
            {"created_at", row.text(11)},
            {"requested_at", nullable(row.optional_text(12))},
            {"approved_at", nullable(row.optional_text(13))},
            {"revoked_at", nullable(row.optional_text(14))},
            {"last_seen_at", nullable(row.optional_text(15))},
            {"linked", row.integer(16) != 0},
            {"rate_exempt", row.integer(17) != 0},
            // When it last asked for bot requests, and how many tools its bridge offered when it last started.
            {"host_seen_at", nullable(row.optional_text(18))},
            {"bridge_tools", row.is_null(19) ? json(nullptr) : json(row.integer(19))},
            // Whether an urgent message may start a turn in this session's client when it is idle.
            {"urgent_dispatch", row.integer(20) != 0},
            // Whether it comes through a bridge (it registered itself), and the tool contract that bridge offers.
            {"self_enrolled", row.integer(21) != 0},
            {"bridge_contract", row.is_null(22) ? json(nullptr) : json(row.integer(22))},
            // A relay bridge follows the service: new tools reach its client without a restart.
            {"bridge_relay", row.integer(23) != 0}};
}

}  // namespace acm
