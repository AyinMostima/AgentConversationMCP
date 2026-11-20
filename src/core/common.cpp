#include "common.hpp"

#include "crypto.hpp"

#include <format>

namespace acm {

ControlError::ControlError(std::string code, const std::string& message, json details)
    : std::runtime_error(message), code_(std::move(code)), details_(std::move(details)) {}

void fail(std::string code, const std::string& message, json details) {
    throw ControlError(std::move(code), message, std::move(details));
}

std::string to_rfc3339(TimePoint time) {
    return std::format("{:%FT%T}Z", std::chrono::floor<std::chrono::milliseconds>(time));
}

std::string new_id(std::string_view prefix) {
    return std::string(prefix) + "_" + random_hex(16);
}

namespace {

const json* find_field(const json& args, std::string_view field) {
    if (!args.is_object()) {
        fail("INVALID_ARGUMENT", "arguments must be a JSON object");
    }
    const auto found = args.find(field);
    if (found == args.end() || found->is_null()) {
        return nullptr;
    }
    return &*found;
}

}  // namespace

std::optional<std::string> optional_string(const json& args, std::string_view field, std::size_t max_length) {
    const json* value = find_field(args, field);
    if (value == nullptr) {
        return std::nullopt;
    }
    if (!value->is_string()) {
        fail("INVALID_ARGUMENT", std::format("{} must be a string", field));
    }
    auto text = value->get<std::string>();
    if (text.empty() || text.size() > max_length) {
        fail("INVALID_ARGUMENT", std::format("{} must be 1 to {} bytes long", field, max_length));
    }
    return text;
}

std::string require_string(const json& args, std::string_view field, std::size_t max_length) {
    auto value = optional_string(args, field, max_length);
    if (!value) {
        fail("INVALID_ARGUMENT", std::format("{} is required", field));
    }
    return *value;
}

std::optional<std::int64_t> optional_integer(const json& args, std::string_view field, std::int64_t low,
                                             std::int64_t high) {
    const json* value = find_field(args, field);
    if (value == nullptr) {
        return std::nullopt;
    }
    if (!value->is_number_integer()) {
        fail("INVALID_ARGUMENT", std::format("{} must be an integer", field));
    }
    const auto number = value->get<std::int64_t>();
    if (number < low || number > high) {
        fail("INVALID_ARGUMENT", std::format("{} must be between {} and {}", field, low, high));
    }
    return number;
}

std::int64_t optional_integer(const json& args, std::string_view field, std::int64_t fallback, std::int64_t low,
                              std::int64_t high) {
    return optional_integer(args, field, low, high).value_or(fallback);
}

bool optional_bool(const json& args, std::string_view field, bool fallback) {
    const json* value = find_field(args, field);
    if (value == nullptr) {
        return fallback;
    }
    if (!value->is_boolean()) {
        fail("INVALID_ARGUMENT", std::format("{} must be a boolean", field));
    }
    return value->get<bool>();
}

std::vector<std::string> optional_string_list(const json& args, std::string_view field, std::size_t max_items) {
    const json* value = find_field(args, field);
    std::vector<std::string> items;
    if (value == nullptr) {
        return items;
    }
    if (!value->is_array() || value->size() > max_items) {
        fail("INVALID_ARGUMENT", std::format("{} must be an array of at most {} strings", field, max_items));
    }
    for (const auto& item : *value) {
        if (!item.is_string() || item.get_ref<const std::string&>().empty()) {
            fail("INVALID_ARGUMENT", std::format("{} must contain non-empty strings", field));
        }
        items.push_back(item.get<std::string>());
    }
    return items;
}

}  // namespace acm
