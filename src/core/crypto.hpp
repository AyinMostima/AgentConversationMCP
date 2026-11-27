// Random identifiers and SHA-256 digests backed by the Windows CNG provider.
#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>

namespace acm {

// `byte_count` random bytes rendered as lowercase hex.
std::string random_hex(std::size_t byte_count);

std::string sha256_hex(std::string_view data);

// PBKDF2-HMAC-SHA256 of `password` with `salt`, 32 bytes as lowercase hex: slow on
// purpose, for stored passwords.
std::string pbkdf2_sha256_hex(std::string_view password, std::string_view salt, std::uint32_t iterations);

// Whether two texts are equal, in a time that does not depend on where they differ.
bool constant_time_equal(std::string_view left, std::string_view right);

// Streams the file so large artifacts are hashed without loading them whole.
std::string sha256_file_hex(const std::filesystem::path& file);

}  // namespace acm
