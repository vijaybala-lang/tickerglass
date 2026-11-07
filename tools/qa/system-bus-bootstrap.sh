#!/usr/bin/env bash
# system-bus-bootstrap.sh — part of TickerGlass
# Copyright (C) 2026 Vijay Bala
# SPDX-License-Identifier: GPL-3.0-or-later
#
# tools/qa/system-bus-bootstrap.sh -- source-me: stand up a throwaway
# permissive system bus so the foreign gnome-shell finds a
# /run/dbus-style system address (loginManager.js connects to the
# system bus during _initializeUI and ABORTS the whole shell when the
# socket is missing -- the host nested runs inherit the desktop's).
#
# Nothing will ever own org.freedesktop.login1 here; the shell's
# getLoginManager() only NEEDS the connection to succeed and then
# degrades on the missing name, exactly like a container-resident
# gnome-boxes session. (Ported from weatherglass.)
BUSCONF=/tmp/qa-system-bus.conf
cat > "$BUSCONF" <<'XML'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>system</type>
  <listen>unix:path=/tmp/qa-system-bus.sock</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
XML
SYSADDR=$(dbus-daemon --config-file="$BUSCONF" --print-address --fork 2>/dev/null | head -1)
export DBUS_SYSTEM_BUS_ADDRESS="${DBUS_SYSTEM_BUS_ADDRESS:-$SYSADDR}"
echo "qa: fake system bus at $DBUS_SYSTEM_BUS_ADDRESS"
