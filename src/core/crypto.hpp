// Random identifiers and SHA-256 digests backed by the Windows CNG provider.
#pragma once

#include <cstddef>
#include <filesystem>
#include <string>
#include <string_view>

namespace acm {

// `byte_count` random bytes rendered as lowercase hex.
std::string random_hex(std::size_t byte_count);

std::string sha256_hex(std::string_view data);

// Streams the file so large artifacts are hashed without loading them whole.
std::string sha256_file_hex(const std::filesystem::path& file);

}  // namespace acm
