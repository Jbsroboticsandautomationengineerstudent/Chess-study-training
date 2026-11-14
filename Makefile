ARCHS = arm64
TARGET = iphone:clang:latest:15.0

THEOS_PACKAGE_SCHEME = rootless

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = Chess

Chess_FILES      = Tweak.xm maia.mm legal.cpp
Chess_FRAMEWORKS = UIKit Foundation QuartzCore CoreML Vision
Chess_LIBRARIES  = substrate
Chess_CFLAGS     = -fobjc-arc -Wno-deprecated-declarations -std=c++17
Chess_LDFLAGS    = -lc++

# embed Maia model into the dylib (files staged at repo root by CI)
ifneq ($(wildcard maia_wghts.bin),)
Chess_LDFLAGS    += -Wl,-sectcreate,__TEXT,__maia_mfst,maia_mfst.json
Chess_LDFLAGS    += -Wl,-sectcreate,__TEXT,__maia_model,maia_model.bin
Chess_LDFLAGS    += -Wl,-sectcreate,__TEXT,__maia_wghts,maia_wghts.bin
endif

include $(THEOS)/makefiles/tweak.mk
