// Installation-wide switches stored in the control database.
//
// open_mode (default on): sessions interconnect without per-item approval.
//   - a client that presents an issued credential and reports itself is paired at once
//   - every linked session joins its project's lobby conversation automatically
//   - a session may open a direct conversation with another linked session
// With open_mode off the operator approves each pairing and decides every
// membership, as before. Topic conversations and their permissions are the
// same in both modes.
//
// Flood control keeps sessions that answer each other from filling a
// conversation: a cap on what one session may write per minute and per hour,
// and a window in which the same text from the same session is one message.
#pragma once

#include "common.hpp"
#include "database.hpp"

namespace acm {

// Plain text values, for the few settings that are not numbers or switches.
std::optional<std::string> text_setting(Database& database, std::string_view key);
void store_text_setting(Database& database, std::string_view key, const std::string& value);
void erase_setting(Database& database, std::string_view key);

bool open_mode(Database& database);
void set_open_mode(Database& database, bool enabled);

// A value of 0 switches that limit off. A session is a whole application, with
// every conversation it has open: the defaults leave room for several of them
// working at once, and still stop two sessions that answer each other without end.
struct MessageLimits {
    std::int64_t per_minute = 60;
    std::int64_t per_hour = 600;
    std::int64_t duplicate_window_seconds = 120;
    // How many messages a session may mark urgent per hour. An urgent message
    // interrupts its readers, so past this number it is stored as an ordinary one.
    std::int64_t urgent_per_hour = 30;
};

MessageLimits message_limits(Database& database);
void set_message_limits(Database& database, const MessageLimits& limits);

// Fails RATE_LIMITED when `actor` already has as many rows in `table` (counted
// by its created_at) as the limits allow. `table` and `column` are names from
// the code, never input. Must run inside the caller's transaction.
void enforce_rate(Database& database, std::string_view table, std::string_view column, std::string_view actor,
                  TimePoint now, std::string_view what);

}  // namespace acm
