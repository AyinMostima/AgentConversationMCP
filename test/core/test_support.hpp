// Shared fixtures for the core module tests: a throwaway database file, a
// controllable clock and a helper that captures the business error code.
#pragma once

#include "core/common.hpp"
#include "core/crypto.hpp"
#include "core/database.hpp"
#include "core/event_log.hpp"

#include <filesystem>
#include <memory>
#include <string>

namespace acm_test {

// Creates a unique database path under the system temp directory and removes
// the database with its WAL side files when the test ends.
class TempStore {
public:
    TempStore() : path_(std::filesystem::temp_directory_path() / ("acm-test-" + acm::random_hex(8) + ".db")) {}
    TempStore(const TempStore&) = delete;
    TempStore& operator=(const TempStore&) = delete;
    ~TempStore() {
        std::error_code ignored;
        for (const char* suffix : {"", "-wal", "-shm"}) {
            std::filesystem::remove(path_.string() + suffix, ignored);
        }
    }
    const std::filesystem::path& path() const { return path_; }

private:
    std::filesystem::path path_;
};

// A clock the test advances explicitly, so expiry is deterministic.
class FakeClock {
public:
    FakeClock() : now_(std::make_shared<acm::TimePoint>(std::chrono::sys_days{std::chrono::year{2026} / 11 / 20})) {}
    acm::Clock clock() const {
        return [now = now_] { return *now; };
    }
    void advance(std::chrono::seconds amount) { *now_ += amount; }

private:
    std::shared_ptr<acm::TimePoint> now_;
};

// Runs `work` and returns the ControlError code it raised, or "NO_ERROR".
template <typename Work>
std::string error_code(Work&& work) {
    try {
        work();
    } catch (const acm::ControlError& error) {
        return error.code();
    }
    return "NO_ERROR";
}

inline void insert_project(acm::Database& database, const std::string& project_id,
                           const std::string& root_path = "") {
    database.execute("INSERT INTO projects (project_id, name, root_path, created_at) VALUES (?, ?, ?, ?)", project_id,
                     "Project " + project_id, root_path, "2026-11-20T00:00:00.000Z");
}

inline std::vector<std::string> event_types(acm::EventLog& events) {
    std::vector<std::string> types;
    for (const auto& event : events.read_after(0, 1000)) {
        types.push_back(event.at("event_type").get<std::string>());
    }
    return types;
}

}  // namespace acm_test
