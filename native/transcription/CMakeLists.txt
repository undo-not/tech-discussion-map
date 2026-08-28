cmake_minimum_required(VERSION 3.25)

cmake_policy(SET CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

project(techmap_transcription LANGUAGES C CXX)

include(FetchContent)

set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_JAVA OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
  whisper
  GIT_REPOSITORY https://github.com/ggml-org/whisper.cpp.git
  GIT_TAG f049fff95a089aa9969deb009cdd4892b3e74916
)
FetchContent_MakeAvailable(whisper)

add_executable(techmap-transcriber src/main.cpp)
target_compile_features(techmap-transcriber PRIVATE cxx_std_20)
target_include_directories(techmap-transcriber PRIVATE src)
target_link_libraries(techmap-transcriber PRIVATE whisper)

add_executable(techmap-transcriber-tests tests/protocol_tests.cpp)
target_compile_features(techmap-transcriber-tests PRIVATE cxx_std_20)
target_include_directories(techmap-transcriber-tests PRIVATE src)

if(MSVC)
  target_compile_options(techmap-transcriber PRIVATE /W4 /WX /permissive- /sdl)
  target_compile_options(techmap-transcriber-tests PRIVATE /W4 /WX /permissive- /sdl)
else()
  target_compile_options(techmap-transcriber PRIVATE -Wall -Wextra -Wpedantic -Werror)
  target_compile_options(techmap-transcriber-tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

enable_testing()
add_test(NAME transcription-protocol COMMAND techmap-transcriber-tests)
