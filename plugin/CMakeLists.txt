# mkwavez as an audio plugin (VST3 / AU / CLAP / LV2 / Standalone) built with JUCE.
#
#   cmake -S plugin -B build -DCMAKE_BUILD_TYPE=Release
#   cmake --build build --config Release
#   ctest --test-dir build -C Release
#
# JUCE and clap-juce-extensions are fetched at pinned versions. To use local checkouts
# (offline, or a JUCE you're hacking on) pass -DFETCHCONTENT_SOURCE_DIR_JUCE=/path/to/JUCE
# and -DFETCHCONTENT_SOURCE_DIR_CLAP_JUCE_EXTENSIONS=/path/to/clap-juce-extensions.
cmake_minimum_required(VERSION 3.22)

# Must precede project(): JUCE 9 supports macOS 10.13+.
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version")

project(mkwavez VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# One runtime for JUCE, the core and the plugin targets on MSVC.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

option(MKWAVEZ_PLUGIN "Build the JUCE plugin (off: only the core library + tests)" ON)
option(MKWAVEZ_CLAP "Build the CLAP format (clap-juce-extensions)" ON)
option(MKWAVEZ_COPY_PLUGIN "Copy built plugins to the user's plugin folders" OFF)

enable_testing()
add_subdirectory(core)

if(NOT MKWAVEZ_PLUGIN)
    return()
endif()

include(FetchContent)
set(FETCHCONTENT_QUIET OFF)

# JUCE 9 is dual licensed: AGPLv3 or a commercial JUCE licence (see docs/PLUGIN.md).
FetchContent_Declare(juce
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 9.0.4
    GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(juce)

set(MKWAVEZ_FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND MKWAVEZ_FORMATS AU)
endif()
if(UNIX AND NOT APPLE)
    list(APPEND MKWAVEZ_FORMATS LV2)
endif()

juce_add_plugin(mkwavez
    PRODUCT_NAME "mkwavez"
    COMPANY_NAME "moonfall"
    BUNDLE_ID "com.moonfall.mkwavez"
    PLUGIN_MANUFACTURER_CODE Mnfl
    PLUGIN_CODE Mkwz
    FORMATS ${MKWAVEZ_FORMATS}
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    VST3_CATEGORIES Instrument Synth
    AU_MAIN_TYPE kAudioUnitType_MusicDevice
    LV2URI "urn:moonfall:mkwavez"
    COPY_PLUGIN_AFTER_BUILD ${MKWAVEZ_COPY_PLUGIN})

target_sources(mkwavez PRIVATE
    source/EngineHost.cpp
    source/Parameters.cpp
    source/PluginEditor.cpp
    source/PluginProcessor.cpp
    source/State.cpp
    source/WavetableView.cpp)

target_compile_definitions(mkwavez PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0)

target_link_libraries(mkwavez
    PRIVATE
        mkwavez_core
        juce::juce_audio_utils
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

# Host test: loads the built VST3 like a DAW and checks audio, MIDI, state, editor.
option(MKWAVEZ_HOST_TEST "Build the VST3 host test (ctest)" ON)
if(MKWAVEZ_HOST_TEST)
    juce_add_console_app(mkwavez_host_test PRODUCT_NAME "mkwavez_host_test")
    target_sources(mkwavez_host_test PRIVATE tests/HostTest.cpp)
    target_compile_definitions(mkwavez_host_test PRIVATE
        JUCE_PLUGINHOST_VST3=1
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        MKWAVEZ_VST3_PATH="$<GENEX_EVAL:$<TARGET_PROPERTY:mkwavez_VST3,JUCE_PLUGIN_ARTEFACT_FILE>>")
    target_link_libraries(mkwavez_host_test PRIVATE
        juce::juce_audio_processors
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_dependencies(mkwavez_host_test mkwavez_VST3)
    add_test(NAME mkwavez_host_test COMMAND mkwavez_host_test)

    # Editor screenshot tool (not a test): links the plugin's shared code directly.
    juce_add_console_app(mkwavez_snapshot PRODUCT_NAME "mkwavez_snapshot")
    target_sources(mkwavez_snapshot PRIVATE tests/Snapshot.cpp)
    target_link_libraries(mkwavez_snapshot PRIVATE mkwavez juce::juce_recommended_config_flags)
    # The shared code keeps JUCE private; borrow its include paths and module definitions.
    target_include_directories(mkwavez_snapshot PRIVATE $<TARGET_PROPERTY:mkwavez,INCLUDE_DIRECTORIES>)
    target_compile_definitions(mkwavez_snapshot PRIVATE $<TARGET_PROPERTY:mkwavez,COMPILE_DEFINITIONS>)
    set_target_properties(mkwavez_snapshot PROPERTIES EXCLUDE_FROM_ALL TRUE)
endif()

if(MKWAVEZ_CLAP)
    FetchContent_Declare(clap_juce_extensions
        GIT_REPOSITORY https://github.com/free-audio/clap-juce-extensions.git
        GIT_TAG 7adee3a1bd4684d4caa5601100e364abccff4b4d)
    FetchContent_MakeAvailable(clap_juce_extensions)
    clap_juce_extensions_plugin(TARGET mkwavez
        CLAP_ID "com.moonfall.mkwavez"
        CLAP_FEATURES instrument synthesizer mono)
endif()
