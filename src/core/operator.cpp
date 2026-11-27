#include "operator.hpp"

#include "crypto.hpp"
#include "settings.hpp"

#include <algorithm>
#include <chrono>
#include <format>

namespace acm {

namespace {

// Names are compared without regard to the case of plain letters.
std::string folded(std::string_view name) {
    std::string lower(name);
    std::ranges::transform(lower, lower.begin(), [](unsigned char c) {
        return static_cast<char>(c >= 'A' && c <= 'Z' ? c + 32 : c);
    });
    return lower;
}

std::string checked_name(const json& args) {
    const std::string name = require_string(args, "username", 64);
    if (name.size() < 2) {
        fail("INVALID_ARGUMENT", "the account name needs at least 2 characters");
    }
    // Shown in the console and typed on a sign-in page: no spaces, nothing invisible.
    for (unsigned char c : name) {
        if (c <= 0x20 || c == 0x7F) {
            fail("INVALID_ARGUMENT", "the account name must not contain spaces or control characters");
        }
    }
    return name;
}

std::string checked_password(const json& args, std::string_view field) {
    const std::string password = require_string(args, field, 256);
    if (password.size() < OperatorAccount::kMinPassword) {
        fail("INVALID_ARGUMENT", std::format("the password needs at least {} characters", OperatorAccount::kMinPassword),
             {{"reason", "password_short"}, {"minimum", OperatorAccount::kMinPassword}});
    }
    return password;
}

// "pbkdf2-sha256$<iterations>$<salt>$<hash>"
std::string hashed(std::string_view password) {
    const std::string salt = random_hex(16);
    return std::format("pbkdf2-sha256${}${}${}", OperatorAccount::kIterations, salt,
                       pbkdf2_sha256_hex(password, salt, OperatorAccount::kIterations));
}

bool matches(std::string_view password, std::string_view stored) {
    const auto first = stored.find('$');
    const auto second = first == std::string_view::npos ? first : stored.find('$', first + 1);
    const auto third = second == std::string_view::npos ? second : stored.find('$', second + 1);
    if (third == std::string_view::npos || stored.substr(0, first) != "pbkdf2-sha256") {
        return false;
    }
    std::uint32_t iterations = 0;
    for (const char c : stored.substr(first + 1, second - first - 1)) {
        if (c < '0' || c > '9' || iterations > 100000000) {
            return false;
        }
        iterations = iterations * 10 + static_cast<std::uint32_t>(c - '0');
    }
    if (iterations == 0) {
        return false;
    }
    const std::string_view salt = stored.substr(second + 1, third - second - 1);
    return constant_time_equal(pbkdf2_sha256_hex(password, salt, iterations), stored.substr(third + 1));
}

}  // namespace

json OperatorAccount::status(bool remote) {
    const bool exists = text_setting(database_, "operator_account").has_value();
    return {{"account", exists}, {"setup_allowed", !exists && !remote}};
}

json OperatorAccount::view() {
    const auto name = text_setting(database_, "operator_account");
    return name ? json{{"username", *name}} : json(nullptr);
}

json OperatorAccount::set(const json& args, std::string_view authority, bool remote) {
    const auto existing = text_setting(database_, "operator_account");
    const auto stored = text_setting(database_, "operator_password");
    if (authority == "none") {
        // Without signing in: the first account only, and only at this machine.
        if (existing) {
            fail("ADMIN_REQUIRED", "sign in to change the account");
        }
        if (remote) {
            fail("ACTION_NOT_ALLOWED",
                 "the first account is made on the machine the service runs on, not through remote access");
        }
    } else if (authority == "login" && existing) {
        // Signed in with the account: a login that fell into other hands must not be
        // enough to take the account over.
        refuse_when_locked(remote);
        const auto current = optional_string(args, "current_password", 256);
        if (!current || !stored || !matches(*current, *stored)) {
            note_failure(remote);
            fail("LOGIN_FAILED", "the current password is not right", {{"reason", "current_password"}});
        }
    }
    const std::string name = existing && !args.contains("username") ? *existing : checked_name(args);
    const std::string password = checked_password(args, "password");
    return database_.transaction([&] {
        store_text_setting(database_, "operator_account", name);
        store_text_setting(database_, "operator_password", hashed(password));
        // A new password ends what was signed in with the old one.
        database_.execute("DELETE FROM operator_logins");
        database_.execute("DELETE FROM operator_login_failures");
        events_.append(existing ? "operator.account_changed" : "operator.account_created", {}, "operator",
                       {{"username", name}, {"remote", remote}});
        return issue(name, remote);
    });
}

void OperatorAccount::refuse_when_locked(bool remote) {
    const auto now = clock_();
    const std::int64_t window = remote ? kWindowSeconds : 60;
    Statement recent = database_.query(
        "SELECT COUNT(*), MIN(at) FROM operator_login_failures WHERE remote = ? AND at > ?", remote ? 1 : 0,
        to_rfc3339(now - std::chrono::seconds(window)));
    recent.step();
    if (recent.integer(0) >= (remote ? kRemoteFailures : kLocalFailures)) {
        fail("RATE_LIMITED",
             remote ? "too many failed sign-ins from outside; try again later, or sign in on the machine itself"
                    : "too many failed sign-ins; wait a minute",
             {{"retry_after_seconds", window}, {"window_seconds", window}});
    }
}

void OperatorAccount::note_failure(bool remote) {
    const auto now = clock_();
    database_.execute("INSERT INTO operator_login_failures (at, remote) VALUES (?, ?)", to_rfc3339(now), remote ? 1 : 0);
    database_.execute("DELETE FROM operator_login_failures WHERE at < ?",
                      to_rfc3339(now - std::chrono::seconds(2 * kWindowSeconds)));
}

json OperatorAccount::login(const json& args, bool remote) {
    const std::string name = require_string(args, "username", 64);
    const std::string password = require_string(args, "password", 256);
    refuse_when_locked(remote);
    const auto account = text_setting(database_, "operator_account");
    const auto stored = text_setting(database_, "operator_password");
    // The slow comparison is made whatever the name was, so that a wrong name and a
    // wrong password cost the same time and look the same.
    const bool password_ok = matches(password, stored.value_or("pbkdf2-sha256$600000$00$00"));
    if (!account || !stored || folded(name) != folded(*account) || !password_ok) {
        note_failure(remote);
        fail("LOGIN_FAILED", "the account name or the password is not right");
    }
    return database_.transaction([&] {
        database_.execute("DELETE FROM operator_login_failures WHERE remote = ?", remote ? 1 : 0);
        database_.execute("DELETE FROM operator_logins WHERE expires_at < ?", to_rfc3339(clock_()));
        events_.append("operator.signed_in", {}, "operator", {{"remote", remote}});
        return issue(*account, remote);
    });
}

json OperatorAccount::issue(std::string_view username, bool remote) {
    const auto now = clock_();
    const std::string token = "acmlogin_" + random_hex(32);
    const std::string expires = to_rfc3339(now + std::chrono::seconds(kLoginSeconds));
    database_.execute(
        "INSERT INTO operator_logins (token_hash, created_at, used_at, expires_at, remote) VALUES (?, ?, ?, ?, ?)",
        sha256_hex(token), to_rfc3339(now), to_rfc3339(now), expires, remote ? 1 : 0);
    return {{"token", token}, {"expires_at", expires}, {"username", std::string(username)}};
}

std::optional<std::string> OperatorAccount::check(std::string_view token) {
    if (!token.starts_with("acmlogin_") || token.size() > 200) {
        return std::nullopt;
    }
    const auto now = clock_();
    const std::string digest = sha256_hex(token);
    Statement row = database_.query("SELECT used_at FROM operator_logins WHERE token_hash = ? AND expires_at > ?", digest,
                                    to_rfc3339(now));
    if (!row.step()) {
        return std::nullopt;
    }
    // Used: good for another kLoginSeconds. Written down every few minutes, not with every request.
    if (row.text(0) < to_rfc3339(now - std::chrono::seconds(300))) {
        database_.execute("UPDATE operator_logins SET used_at = ?, expires_at = ? WHERE token_hash = ?", to_rfc3339(now),
                          to_rfc3339(now + std::chrono::seconds(kLoginSeconds)), digest);
    }
    return text_setting(database_, "operator_account").value_or("");
}

void OperatorAccount::logout(std::string_view token) {
    database_.execute("DELETE FROM operator_logins WHERE token_hash = ?", sha256_hex(token));
}

void OperatorAccount::logout_all() {
    database_.execute("DELETE FROM operator_logins");
}

}  // namespace acm
