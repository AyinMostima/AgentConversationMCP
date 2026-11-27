// The operator's account for the console: a name and a password in place of the
// long credential in admin-token.txt.
//
// The credential file stays what it was: the key of this installation, for the
// command line and for getting back in when the password is forgotten. The
// account is the everyday way in. Signing in with it yields a login, a random
// token the browser keeps and presents like the credential; the service stores
// only its digest.
//
// Guessing is slowed down in three ways: the password is stored as a slow
// salted hash (PBKDF2-HMAC-SHA256), failed attempts are counted, and past a
// number of them signing in is refused for a while. Attempts that come in
// through the tunnel are counted apart from those made on this machine, so that
// nobody outside can lock out the person sitting at it.
#pragma once

#include "common.hpp"
#include "database.hpp"
#include "event_log.hpp"

#include <optional>
#include <string>
#include <string_view>

namespace acm {

class OperatorAccount {
public:
    // A login is good for this long after it was last used.
    static constexpr std::int64_t kLoginSeconds = 30 * 24 * 3600;
    // Failed attempts through the tunnel within kWindowSeconds before signing in from
    // outside is refused until the window has passed; and the same for this machine,
    // within a minute.
    static constexpr std::int64_t kWindowSeconds = 600;
    static constexpr std::int64_t kRemoteFailures = 20;
    static constexpr std::int64_t kLocalFailures = 10;
    static constexpr std::size_t kMinPassword = 8;
    static constexpr std::uint32_t kIterations = 600000;

    OperatorAccount(Database& database, EventLog& events, Clock clock)
        : database_(database), events_(events), clock_(std::move(clock)) {}

    /// What the sign-in page needs to know: {account, setup_allowed}. An account can be
    /// made without signing in only while there is none, and only on this machine.
    json status(bool remote);

    /// {username, password, current_password?}: makes the account, or changes it.
    /// `authority` is how the caller is known: "none" (not signed in), "login" (signed in
    /// with the account, which then has to give the current password) or "credential"
    /// (the installation's own credential, which may also reset a forgotten password).
    /// Every login made before is ended; the answer carries a new one.
    json set(const json& args, std::string_view authority, bool remote);

    /// {username, password} -> {token, expires_at, username}. LOGIN_FAILED when either is wrong.
    json login(const json& args, bool remote);

    /// The name of the account a login token stands for, when the token is good.
    std::optional<std::string> check(std::string_view token);

    /// Ends one login, or all of them.
    void logout(std::string_view token);
    void logout_all();

    /// For the console: {username} or null.
    json view();

private:
    json issue(std::string_view username, bool remote);
    void refuse_when_locked(bool remote);
    void note_failure(bool remote);

    Database& database_;
    EventLog& events_;
    Clock clock_;
};

}  // namespace acm
