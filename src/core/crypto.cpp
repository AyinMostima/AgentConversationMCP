#include "crypto.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <bcrypt.h>

#include <array>
#include <fstream>
#include <stdexcept>
#include <vector>

namespace acm {

namespace {

void check(NTSTATUS status, const char* operation) {
    if (status < 0) {
        throw std::runtime_error(std::string("CNG call failed: ") + operation);
    }
}

std::string to_hex(const unsigned char* bytes, std::size_t count) {
    static constexpr char digits[] = "0123456789abcdef";
    std::string hex(count * 2, '0');
    for (std::size_t index = 0; index < count; ++index) {
        hex[index * 2] = digits[bytes[index] >> 4];
        hex[index * 2 + 1] = digits[bytes[index] & 0x0F];
    }
    return hex;
}

// Incremental SHA-256 so buffers and files share one implementation.
class Sha256 {
public:
    Sha256() {
        check(BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0), "open SHA-256");
        check(BCryptCreateHash(algorithm_, &hash_, nullptr, 0, nullptr, 0, 0), "create hash");
    }
    Sha256(const Sha256&) = delete;
    Sha256& operator=(const Sha256&) = delete;
    ~Sha256() {
        BCryptDestroyHash(hash_);
        BCryptCloseAlgorithmProvider(algorithm_, 0);
    }

    void update(const char* data, std::size_t size) {
        check(BCryptHashData(hash_, reinterpret_cast<PUCHAR>(const_cast<char*>(data)), static_cast<ULONG>(size), 0),
              "hash data");
    }

    std::string finish() {
        std::array<unsigned char, 32> digest{};
        check(BCryptFinishHash(hash_, digest.data(), static_cast<ULONG>(digest.size()), 0), "finish hash");
        return to_hex(digest.data(), digest.size());
    }

private:
    BCRYPT_ALG_HANDLE algorithm_ = nullptr;
    BCRYPT_HASH_HANDLE hash_ = nullptr;
};

}  // namespace

std::string random_hex(std::size_t byte_count) {
    std::vector<unsigned char> bytes(byte_count);
    check(BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG),
          "generate random bytes");
    return to_hex(bytes.data(), bytes.size());
}

std::string pbkdf2_sha256_hex(std::string_view password, std::string_view salt, std::uint32_t iterations) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, BCRYPT_ALG_HANDLE_HMAC_FLAG),
          "open HMAC-SHA-256");
    std::vector<unsigned char> key(32);
    const NTSTATUS status = BCryptDeriveKeyPBKDF2(
        algorithm, reinterpret_cast<PUCHAR>(const_cast<char*>(password.data())), static_cast<ULONG>(password.size()),
        reinterpret_cast<PUCHAR>(const_cast<char*>(salt.data())), static_cast<ULONG>(salt.size()), iterations, key.data(),
        static_cast<ULONG>(key.size()), 0);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    check(status, "derive a key from a password");
    return to_hex(key.data(), key.size());
}

bool constant_time_equal(std::string_view left, std::string_view right) {
    unsigned char difference = left.size() == right.size() ? 0 : 1;
    for (std::size_t index = 0; index < left.size(); ++index) {
        difference |= static_cast<unsigned char>(left[index] ^ (index < right.size() ? right[index] : 0));
    }
    return difference == 0;
}

std::string sha256_hex(std::string_view data) {
    Sha256 hash;
    hash.update(data.data(), data.size());
    return hash.finish();
}

std::string sha256_file_hex(const std::filesystem::path& file) {
    std::ifstream stream(file, std::ios::binary);
    if (!stream) {
        throw std::runtime_error("cannot open file for hashing: " + file.string());
    }
    Sha256 hash;
    std::vector<char> buffer(1 << 16);
    while (stream) {
        stream.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
        const auto read = stream.gcount();
        if (read > 0) {
            hash.update(buffer.data(), static_cast<std::size_t>(read));
        }
    }
    return hash.finish();
}

}  // namespace acm
