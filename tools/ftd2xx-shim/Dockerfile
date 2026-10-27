# Build environment for the 32-bit shim DLL.
#
# 32-bit because BMWScan140.exe is a 32-bit Delphi binary and will only load a 32-bit DLL, and
# this machine's Visual Studio has no C++ workload. Built as an image rather than a one-off
# `docker run ... apt-get install` because the search for the cable's sign-on means rebuilding
# repeatedly, and paying for the toolchain download each time would make that tedious.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends gcc-mingw-w64-i686 binutils-mingw-w64-i686 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
