#include "settings.hpp"

#include <algorithm>
#include <charconv>
#include <format>
#include <utility>

namespace acm {

namespace {

std::int64_t integer_setting(Database& database, std::string_view key, std::int64_t fallback) {
    Statement row = database.query("SELECT value FROM settings WHERE key = ?", key);
    if (!row.step()) {
        return fallback;
    }
    const std::string text = row.text(0);
    std::int64_t value = fallback;
    std::from_chars(text.data(), text.data() + text.size(), value);
    return value;
}

void store_setting(Database& database, std::string_view key, const std::string& value) {
    database.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key,
        value);
}

}  // namespace

std::optional<std::string> text_setting(Database& database, std::string_view key) {
    Statement row = database.query("SELECT value FROM settings WHERE key = ?", key);
    return row.step() ? std::optional<std::string>(row.text(0)) : std::nullopt;
}

void store_text_setting(Database& database, std::string_view key, const std::string& value) {
    store_setting(database, key, value);
}

void erase_setting(Database& database, std::string_view key) {
    database.execute("DELETE FROM settings WHERE key = ?", key);
}

bool open_mode(Database& database) {
    Statement row = database.query("SELECT value FROM settings WHERE key = 'open_mode'");
    // Absent means the default: interconnection is on.
    return !row.step() || row.text(0) != "0";
}

void set_open_mode(Database& database, bool enabled) {
    store_setting(database, "open_mode", enabled ? "1" : "0");
}

MessageLimits message_limits(Database& database) {
    const MessageLimits defaults;
    return {integer_setting(database, "message_rate_per_minute", defaults.per_minute),
            integer_setting(database, "message_rate_per_hour", defaults.per_hour),
            integer_setting(database, "duplicate_window_seconds", defaults.duplicate_window_seconds),
            integer_setting(database, "urgent_per_hour", defaults.urgent_per_hour)};
}

void set_message_limits(Database& database, const MessageLimits& limits) {
    store_setting(database, "message_rate_per_minute", std::to_string(limits.per_minute));
    store_setting(database, "message_rate_per_hour", std::to_string(limits.per_hour));
    store_setting(database, "duplicate_window_seconds", std::to_string(limits.duplicate_window_seconds));
    store_setting(database, "urgent_per_hour", std::to_string(limits.urgent_per_hour));
}

void enforce_rate(Database& database, std::string_view table, std::string_view column, std::string_view actor,
                  TimePoint now, std::string_view what) {
    const MessageLimits limits = message_limits(database);
    const std::pair<std::int64_t, std::int64_t> windows[] = {{limits.per_minute, 60}, {limits.per_hour, 3600}};
    const auto moment = to_rfc3339(now);
    for (const auto& [limit, seconds] : windows) {
        if (limit <= 0) {
            continue;
        }
        // Besides the count: how long until the oldest row leaves the window.
        Statement row = database.query(
            std::format("SELECT COUNT(*), CAST(? - (julianday(?) - julianday(MIN(created_at))) * 86400.0 AS INTEGER) + 1 "
                        "FROM {} WHERE {} = ? AND created_at > ?",
                        table, column),
            seconds, moment, actor, to_rfc3339(now - std::chrono::seconds(seconds)));
        row.step();
        if (row.integer(0) >= limit) {
            const std::int64_t wait = std::clamp<std::int64_t>(row.integer(1), 1, seconds);
            fail("RATE_LIMITED",
                 std::format("this session already sent {} {} in the last {} seconds, the limit is {}. Wait {} seconds. "
                             "Do not retry in a loop, and do not answer a message that needs no answer.",
                             row.integer(0), what, seconds, limit, wait),
                 {{"limit", limit}, {"window_seconds", seconds}, {"retry_after_seconds", wait}});
        }
    }
}

}  // namespace acm
