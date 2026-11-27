#!/bin/bash
# AV_Lock.sh - CoreAudio hardware lock for MarshallCam
# Locks: Input = C922 Pro Stream Webcam, Output = HDMI (100012589)
# Runs periodically to survive device reconnections

KIOSK_DIR="$HOME/MarshallOS"
LOG_FILE="$KIOSK_DIR/avlock.log"

[ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ] && mv "$LOG_FILE" "$LOG_FILE.old"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [AV_Lock] $1" >> "$LOG_FILE"; }

osascript -e "set volume output volume 100" 2>/dev/null
osascript -e "set volume input volume 100" 2>/dev/null

lock_audio() {
/usr/bin/python3 << 'PYEOF'
import sys, ctypes
from ctypes import c_uint32, c_void_p, byref, sizeof
ca = ctypes.CDLL('/System/Library/Frameworks/CoreAudio.framework/CoreAudio')
cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
class Addr(ctypes.Structure):
    _fields_ = [('mSelector', c_uint32), ('mScope', c_uint32), ('mElement', c_uint32)]
SYS = 1; GLOBAL = c_uint32(0x676C6F62); ELEM0 = c_uint32(0)
OWN = c_uint32(0x6F776E64); ADEV = c_uint32(0x61646576); NAME = c_uint32(0x6C6E616D)
DIN = c_uint32(0x64496E20); DOUT = c_uint32(0x644F7574); DSYS = c_uint32(0x64737973)
def c2s(p):
    if not p or not p.value: return None
    cf.CFStringGetLength.argtypes=[c_void_p]; cf.CFStringGetLength.restype=c_uint32
    n=cf.CFStringGetLength(p); b=ctypes.create_string_buffer((n+1)*4)
    cf.CFStringGetCString.argtypes=[c_void_p,ctypes.c_char_p,c_uint32,c_uint32]; cf.CFStringGetCString.restype=ctypes.c_bool
    cf.CFStringGetCString(p,b,(n+1)*4,0x08000100); r=b.value.decode('utf-8'); cf.CFRelease(p); return r
def gname(d):
    a=Addr(NAME,GLOBAL,ELEM0); np=c_void_p(); s=c_uint32(sizeof(c_void_p))
    return c2s(np) if ca.AudioObjectGetPropertyData(d,byref(a),0,None,byref(s),byref(np))==0 else None
def devs():
    a=Addr(OWN,GLOBAL,ELEM0); q=byref(ADEV); qs=sizeof(c_uint32); sz=c_uint32()
    if ca.AudioObjectGetPropertyDataSize(SYS,byref(a),qs,q,byref(sz))!=0: return []
    n=sz.value//4; dd=(c_uint32*n)()
    if ca.AudioObjectGetPropertyData(SYS,byref(a),qs,q,byref(sz),dd)!=0: return []
    return [(d,gname(d)) for d in dd if gname(d)]
def setdev(d,inp):
    sel=DIN if inp else DOUT; a=Addr(sel,GLOBAL,ELEM0); dv=c_uint32(d)
    return ca.AudioObjectSetPropertyData(SYS,byref(a),0,None,sizeof(c_uint32),byref(dv))==0
def setsys(d):
    a=Addr(DSYS,GLOBAL,ELEM0); dv=c_uint32(d)
    return ca.AudioObjectSetPropertyData(SYS,byref(a),0,None,sizeof(c_uint32),byref(dv))==0
dd=devs(); iid=oid=None
for did,nm in dd:
    if nm=='C922 Pro Stream Webcam': iid=did
    if nm=='100012589': oid=did
ok=True
if iid and setdev(iid,True): print(f'Input locked: C922 (ID {iid})')
else: print(f'Input FAIL: C922'); ok=False
if oid and setdev(oid,False): print(f'Output locked: HDMI (ID {oid})')
else: print(f'Output FAIL: HDMI'); ok=False
if oid and setsys(oid): print(f'System output locked: HDMI')
sys.exit(0 if ok else 1)
PYEOF
}

# Initial lock
log "Applying initial AV lock..."
lock_audio >> "$LOG_FILE" 2>&1

# Continuous monitoring loop
while true; do
    sleep 15
    osascript -e "set volume output volume 100" 2>/dev/null
    osascript -e "set volume input volume 100" 2>/dev/null
    result=$(lock_audio 2>&1)
    log "$result"
done