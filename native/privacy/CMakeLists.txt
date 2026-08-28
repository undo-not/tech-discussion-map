cmake_minimum_required(VERSION 3.25)

cmake_policy(SET CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

project(techmap_privacy LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The TechMap privacy helper only supports Windows.")
endif()

add_executable(techmap-privacy src/main.cpp)
target_compile_features(techmap-privacy PRIVATE cxx_std_20)
target_compile_definitions(techmap-privacy PRIVATE NOMINMAX UNICODE _UNICODE WIN32_LEAN_AND_MEAN)
target_compile_options(techmap-privacy PRIVATE /W4 /WX /permissive- /sdl)
target_link_libraries(techmap-privacy PRIVATE Advapi32 Crypt32 Ole32 Shell32 Winhttp)

enable_testing()
add_test(NAME privacy-self-test COMMAND techmap-privacy self-test)
