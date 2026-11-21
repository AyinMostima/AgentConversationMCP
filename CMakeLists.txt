cmake_minimum_required(VERSION 3.25)
project(AgentConversationMCP VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(unofficial-sqlite3 CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

# Control core: the single owner of the message store and the only rule entry.
add_library(acm_core STATIC
    src/core/board.cpp
    src/core/bot_control.cpp
    src/core/common.cpp
    src/core/control_service.cpp
    src/core/conversation.cpp
    src/core/crypto.cpp
    src/core/database.cpp
    src/core/event_log.cpp
    src/core/identity.cpp
    src/core/message.cpp
    src/core/progress.cpp
    src/core/settings.cpp
    src/core/wake.cpp
    src/core/delivery.cpp
    src/core/window.cpp
)
target_include_directories(acm_core PUBLIC src)
target_link_libraries(acm_core PUBLIC unofficial::sqlite3::sqlite3 nlohmann_json::nlohmann_json PRIVATE bcrypt)
target_compile_options(acm_core PUBLIC /W4 /utf-8 /permissive-)
target_compile_definitions(acm_core PUBLIC _CRT_SECURE_NO_WARNINGS)

# HTTP face of the control service (operator API, agent command endpoint, SSE).
find_package(Drogon CONFIG REQUIRED)
add_executable(acm-core src/server/main.cpp)
target_link_libraries(acm-core PRIVATE acm_core Drogon::Drogon)
target_compile_definitions(acm-core PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)

include(CTest)
if(BUILD_TESTING)
    find_package(Catch2 3 CONFIG REQUIRED)
    include(Catch)
    # One executable per production module; test files mirror src/.
    function(acm_core_test module)
        add_executable(test_core_${module} test/core/${module}.test.cpp)
        target_include_directories(test_core_${module} PRIVATE test)
        target_link_libraries(test_core_${module} PRIVATE acm_core Catch2::Catch2WithMain)
        catch_discover_tests(test_core_${module} TEST_PREFIX "core.${module}: ")
    endfunction()
    acm_core_test(identity)
    acm_core_test(conversation)
    acm_core_test(message)
    acm_core_test(progress)
    acm_core_test(board)
acm_core_test(bot_control)
acm_core_test(wake)
acm_core_test(delivery)
    acm_core_test(window)
endif()
