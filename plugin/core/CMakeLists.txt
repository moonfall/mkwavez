# mkwavez_core: the JUCE-free C++ port of src/core (DSP, playback, engine, MIDI routing).
# Builds on its own (cmake -S plugin/core -B build-core) or as part of plugin/.
cmake_minimum_required(VERSION 3.22)
project(mkwavez_core VERSION 0.1.0 LANGUAGES CXX)

if(NOT CMAKE_CXX_STANDARD)
    set(CMAKE_CXX_STANDARD 20)
    set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()

add_library(mkwavez_core STATIC
    src/dsp.cpp
    src/engine.cpp
    src/playback.cpp)
target_include_directories(mkwavez_core PUBLIC include)
target_compile_features(mkwavez_core PUBLIC cxx_std_20)
set_target_properties(mkwavez_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(MSVC)
    target_compile_options(mkwavez_core PRIVATE /W4)
else()
    target_compile_options(mkwavez_core PRIVATE -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion)
endif()

option(MKWAVEZ_CORE_TESTS "Build the core unit tests (ctest)" ON)
if(MKWAVEZ_CORE_TESTS)
    enable_testing()
    add_executable(mkwavez_core_tests
        tests/main.cpp
        tests/golden.cpp
        tests/engine_tests.cpp
        tests/misc_tests.cpp)
    target_link_libraries(mkwavez_core_tests PRIVATE mkwavez_core)
    target_compile_definitions(mkwavez_core_tests PRIVATE
        MKWAVEZ_GOLDEN_FILE="${CMAKE_CURRENT_SOURCE_DIR}/tests/golden/core.golden.txt")
    find_package(Threads REQUIRED)
    target_link_libraries(mkwavez_core_tests PRIVATE Threads::Threads)
    add_test(NAME mkwavez_core_tests COMMAND mkwavez_core_tests)
endif()
