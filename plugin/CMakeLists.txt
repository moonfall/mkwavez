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
option(MKWAVEZ_WEBVIEW "Editor: the web UI in an embedded web view (OFF: a minimal native editor)" ON)
option(MKWAVEZ_BUILD_WEB "Build the web UI (npm run build) as part of the plugin build" ON)
set(MKWAVEZ_WEB_DIST "${CMAKE_CURRENT_SOURCE_DIR}/../dist" CACHE PATH "The built web app (vite build output) to embed")

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

# ---- the web UI, zipped into the binary ----
if(MKWAVEZ_WEBVIEW)
    get_filename_component(MKWAVEZ_WEB_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
    set(MKWAVEZ_WEB_ZIP "${CMAKE_CURRENT_BINARY_DIR}/web/web.zip")
    find_program(MKWAVEZ_NPM NAMES npm npm.cmd)
    if(MKWAVEZ_BUILD_WEB AND MKWAVEZ_NPM)
        if(NOT EXISTS "${MKWAVEZ_WEB_ROOT}/node_modules")
            message(STATUS "mkwavez: npm ci (web UI dependencies)")
            execute_process(COMMAND "${MKWAVEZ_NPM}" ci WORKING_DIRECTORY "${MKWAVEZ_WEB_ROOT}" RESULT_VARIABLE npm_result)
            if(NOT npm_result EQUAL 0)
                message(FATAL_ERROR "npm ci failed in ${MKWAVEZ_WEB_ROOT}")
            endif()
        endif()
        file(GLOB_RECURSE MKWAVEZ_WEB_SOURCES CONFIGURE_DEPENDS "${MKWAVEZ_WEB_ROOT}/src/*")
        set(MKWAVEZ_WEB_DIST "${MKWAVEZ_WEB_ROOT}/dist" CACHE PATH "" FORCE)
        add_custom_command(OUTPUT "${MKWAVEZ_WEB_ZIP}"
            COMMAND "${MKWAVEZ_NPM}" run build
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_CURRENT_BINARY_DIR}/web"
            COMMAND "${CMAKE_COMMAND}" -E rm -f "${MKWAVEZ_WEB_ZIP}"
            COMMAND "${CMAKE_COMMAND}" -E chdir "${MKWAVEZ_WEB_DIST}" "${CMAKE_COMMAND}" -E tar cf "${MKWAVEZ_WEB_ZIP}" --format=zip index.html assets
            WORKING_DIRECTORY "${MKWAVEZ_WEB_ROOT}"
            DEPENDS ${MKWAVEZ_WEB_SOURCES} "${MKWAVEZ_WEB_ROOT}/index.html" "${MKWAVEZ_WEB_ROOT}/vite.config.ts" "${MKWAVEZ_WEB_ROOT}/package.json"
            COMMENT "Building and zipping the web UI"
            VERBATIM)
    else()
        if(NOT EXISTS "${MKWAVEZ_WEB_DIST}/index.html")
            message(FATAL_ERROR "No built web UI at ${MKWAVEZ_WEB_DIST} (run `npm ci && npm run build` at the repo root, "
                                "set MKWAVEZ_WEB_DIST, or configure with -DMKWAVEZ_WEBVIEW=OFF)")
        endif()
        add_custom_command(OUTPUT "${MKWAVEZ_WEB_ZIP}"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_CURRENT_BINARY_DIR}/web"
            COMMAND "${CMAKE_COMMAND}" -E rm -f "${MKWAVEZ_WEB_ZIP}"
            COMMAND "${CMAKE_COMMAND}" -E chdir "${MKWAVEZ_WEB_DIST}" "${CMAKE_COMMAND}" -E tar cf "${MKWAVEZ_WEB_ZIP}" --format=zip index.html assets
            DEPENDS "${MKWAVEZ_WEB_DIST}/index.html"
            COMMENT "Zipping the web UI"
            VERBATIM)
    endif()
    juce_add_binary_data(mkwavez_web HEADER_NAME BinaryData.h NAMESPACE MkwavezWeb SOURCES "${MKWAVEZ_WEB_ZIP}")

    # Windows: WebView2 (Edge) via the NuGet package, linked statically (no loader DLL to ship).
    if(WIN32)
        FetchContent_Declare(webview2
            URL https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.3485.44
            DOWNLOAD_NAME webview2.zip
            SOURCE_DIR "${CMAKE_CURRENT_BINARY_DIR}/webview2/Microsoft.Web.WebView2")
        FetchContent_MakeAvailable(webview2)
        set(JUCE_WEBVIEW2_PACKAGE_LOCATION "${CMAKE_CURRENT_BINARY_DIR}/webview2")
    endif()
endif()

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
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    NEEDS_WEB_BROWSER ${MKWAVEZ_WEBVIEW}
    NEEDS_WEBVIEW2 ${MKWAVEZ_WEBVIEW}
    VST3_CATEGORIES Instrument Synth
    AU_MAIN_TYPE kAudioUnitType_MusicDevice
    LV2URI "urn:moonfall:mkwavez"
    COPY_PLUGIN_AFTER_BUILD ${MKWAVEZ_COPY_PLUGIN})

target_sources(mkwavez PRIVATE
    source/EngineHost.cpp
    source/WebLink.cpp
    source/Parameters.cpp
    source/PluginEditor.cpp
    source/PluginProcessor.cpp
    source/State.cpp
    source/SynthJson.cpp
    source/WavetableView.cpp)

if(MKWAVEZ_WEBVIEW)
    target_sources(mkwavez PRIVATE source/WebEditor.cpp)
    target_link_libraries(mkwavez PRIVATE mkwavez_web)
    target_compile_definitions(mkwavez PUBLIC
        MKWAVEZ_WEBVIEW=1
        JUCE_WEB_BROWSER=1
        JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1)
else()
    target_compile_definitions(mkwavez PUBLIC MKWAVEZ_WEBVIEW=0 JUCE_WEB_BROWSER=0)
endif()

target_compile_definitions(mkwavez PUBLIC
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

    # End-to-end with the real web view editor (Linux / WebKitGTK; needs a display: xvfb-run).
    if(MKWAVEZ_WEBVIEW AND UNIX AND NOT APPLE)
        juce_add_console_app(mkwavez_web_test PRODUCT_NAME "mkwavez_web_test")
        target_sources(mkwavez_web_test PRIVATE tests/WebTest.cpp)
        target_link_libraries(mkwavez_web_test PRIVATE mkwavez juce::juce_recommended_config_flags)
        target_include_directories(mkwavez_web_test PRIVATE $<TARGET_PROPERTY:mkwavez,INCLUDE_DIRECTORIES>)
        target_compile_definitions(mkwavez_web_test PRIVATE $<TARGET_PROPERTY:mkwavez,COMPILE_DEFINITIONS>)
        add_test(NAME mkwavez_web_test COMMAND mkwavez_web_test)
        set_tests_properties(mkwavez_web_test PROPERTIES TIMEOUT 180)
    endif()
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
