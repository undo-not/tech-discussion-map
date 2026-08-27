cmake_minimum_required(VERSION 3.25)

project(techmap_teams_captions LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The TechMap Teams caption helper only supports Windows.")
endif()

add_executable(techmap-captions
  src/main.cpp
)

target_compile_features(techmap-captions PRIVATE cxx_std_20)
target_compile_definitions(techmap-captions PRIVATE
  NOMINMAX
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
)
target_compile_options(techmap-captions PRIVATE /W4 /WX /permissive- /sdl)
target_link_libraries(techmap-captions PRIVATE Ole32 OleAut32 Uiautomationcore)

enable_testing()
add_test(NAME caption-probe-contract COMMAND techmap-captions contract)
