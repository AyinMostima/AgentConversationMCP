// Shared primitives for the control core: stable business errors, time, ids
// and argument validation for JSON commands.
#pragma once

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace acm {

using json = nlohmann::json;
using TimePoint = std::chrono::system_clock::time_point;
using Clock = std::function<TimePoint()>;

// A rejected command. `code` is a stable identifier that clients may branch on.
class ControlError : public std::runtime_error {
public:
    ControlError(std::string code, const std::string& message, json details = json::object());
    const std::string& code() const noexcept { return code_; }
    const json& details() const noexcept { return details_; }

private:
    std::string code_;
    json details_;
};

[[noreturn]] void fail(std::string code, const std::string& message, json details = json::object());

// UTC RFC 3339 with millisecond precision; fixed width so strings sort by time.
std::string to_rfc3339(TimePoint time);

// "<prefix>_<32 hex chars>" from the system random source.
std::string new_id(std::string_view prefix);

std::string require_string(const json& args, std::string_view field, std::size_t max_length = 4096);
std::optional<std::string> optional_string(const json& args, std::string_view field, std::size_t max_length = 4096);
std::int64_t optional_integer(const json& args, std::string_view field, std::int64_t fallback, std::int64_t low,
                              std::int64_t high);
std::optional<std::int64_t> optional_integer(const json& args, std::string_view field, std::int64_t low,
                                             std::int64_t high);
bool optional_bool(const json& args, std::string_view field, bool fallback);
std::vector<std::string> optional_string_list(const json& args, std::string_view field, std::size_t max_items = 64);

}  // namespace acm
