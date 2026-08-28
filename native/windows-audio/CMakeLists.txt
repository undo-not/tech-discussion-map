cmake_minimum_required(VERSION 3.25)

cmake_policy(SET CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

project(techmap_windows_audio LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The TechMap audio helper only supports Windows.")
endif()

add_executable(techmap-audio
  src/main.cpp
)

target_compile_features(techmap-audio PRIVATE cxx_std_20)
target_compile_definitions(techmap-audio PRIVATE
  NOMINMAX
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
)
target_compile_options(techmap-audio PRIVATE /W4 /WX /permissive- /sdl)
target_link_libraries(techmap-audio PRIVATE Advapi32 Mmdevapi Ole32)

add_executable(techmap-audio-state-tests
  tests/state_tests.cpp
)
target_compile_features(techmap-audio-state-tests PRIVATE cxx_std_20)
target_compile_options(techmap-audio-state-tests PRIVATE /W4 /WX /permissive- /sdl)
target_include_directories(techmap-audio-state-tests PRIVATE src)

enable_testing()
add_test(NAME capture-state-machine COMMAND techmap-audio-state-tests)
