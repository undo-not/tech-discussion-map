cmake_minimum_required(VERSION 3.25)

cmake_policy(SET CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

project(techmap_teams_captions LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The TechMap Teams caption helper only supports Windows.")
endif()

add_executable(techmap-captions
  src/main.cpp
  src/ocr_runtime.cpp
)

target_compile_features(techmap-captions PRIVATE cxx_std_20)
target_compile_definitions(techmap-captions PRIVATE
  NOMINMAX
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
)
target_compile_options(techmap-captions PRIVATE /W4 /WX /permissive- /sdl)
target_link_libraries(techmap-captions PRIVATE Bcrypt Gdi32 Ole32 OleAut32 Uiautomationcore User32)

enable_testing()
add_test(NAME caption-probe-contract COMMAND techmap-captions contract)
set_tests_properties(caption-probe-contract PROPERTIES PASS_REGULAR_EXPRESSION "\\\"contentEmitted\\\":false")

add_test(NAME caption-direct-capture-rejected COMMAND techmap-captions ocr-capture --consent-confirmed --session-proof aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
set_tests_properties(caption-direct-capture-rejected PROPERTIES WILL_FAIL TRUE)

add_executable(techmap-caption-tests
  tests/caption_tests.cpp
)
target_compile_features(techmap-caption-tests PRIVATE cxx_std_20)
target_compile_options(techmap-caption-tests PRIVATE /W4 /WX /permissive- /sdl)
target_include_directories(techmap-caption-tests PRIVATE src)
add_test(NAME caption-pure-contracts COMMAND techmap-caption-tests)
