// Thin RAII layer over SQLite: prepared statements, short immediate
// transactions and ordered, versioned migrations. One Database is the single
// authoritative store for messages, control state and committed events.
#pragma once

#include <sqlite3.h>

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>

namespace acm {

class Statement {
public:
    Statement(sqlite3* connection, std::string_view sql);
    Statement(Statement&& other) noexcept : handle_(std::exchange(other.handle_, nullptr)) {}
    Statement(const Statement&) = delete;
    Statement& operator=(const Statement&) = delete;
    ~Statement();

    template <typename... Args>
    Statement& bind_all(const Args&... args) {
        int index = 0;
        (bind(++index, args), ...);
        return *this;
    }

    void bind(int index, std::string_view value);
    void bind(int index, const std::string& value) { bind(index, std::string_view(value)); }
    void bind(int index, const char* value) { bind(index, std::string_view(value)); }
    void bind(int index, std::int64_t value);
    void bind(int index, int value) { bind(index, static_cast<std::int64_t>(value)); }
    void bind(int index, bool value) { bind(index, static_cast<std::int64_t>(value ? 1 : 0)); }
    void bind(int index, double value);
    void bind(int index, std::nullptr_t);
    template <typename T>
    void bind(int index, const std::optional<T>& value) {
        if (value) {
            bind(index, *value);
        } else {
            bind(index, nullptr);
        }
    }

    // Advances to the next row; false once the statement is exhausted.
    bool step();

    bool is_null(int column) const;
    std::string text(int column) const;
    std::optional<std::string> optional_text(int column) const;
    std::int64_t integer(int column) const;
    std::optional<std::int64_t> optional_integer(int column) const;
    std::optional<double> optional_real(int column) const;

private:
    sqlite3_stmt* handle_ = nullptr;
};

class Database {
public:
    // Opens (creating if needed) the file in WAL mode and applies migrations.
    explicit Database(const std::filesystem::path& file);
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;
    ~Database();

    template <typename... Args>
    Statement query(std::string_view sql, const Args&... args) {
        Statement statement(connection_, sql);
        statement.bind_all(args...);
        return statement;
    }

    // Runs a statement to completion and returns the number of changed rows.
    template <typename... Args>
    std::int64_t execute(std::string_view sql, const Args&... args) {
        Statement statement = query(sql, args...);
        while (statement.step()) {
        }
        return sqlite3_changes64(connection_);
    }

    void script(const char* sql);

    // Runs `work` in one BEGIN IMMEDIATE transaction; any exception rolls back.
    template <typename Work>
    auto transaction(Work&& work) -> std::invoke_result_t<Work> {
        script("BEGIN IMMEDIATE");
        try {
            if constexpr (std::is_void_v<std::invoke_result_t<Work>>) {
                work();
                script("COMMIT");
            } else {
                auto result = work();
                script("COMMIT");
                return result;
            }
        } catch (...) {
            script("ROLLBACK");
            throw;
        }
    }

    std::int64_t last_insert_rowid() const { return sqlite3_last_insert_rowid(connection_); }
    int schema_version();

private:
    void migrate();

    sqlite3* connection_ = nullptr;
};

}  // namespace acm
