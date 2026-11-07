# fedora.Containerfile — part of TickerGlass
# Copyright (C) 2026 Vijay Bala
# SPDX-License-Identifier: GPL-3.0-or-later
#
# QA guest for certifying TickerGlass on an OLDER GNOME release than
# the dev box runs. Build via tools/qa/run-old-shell.sh (never by
# hand -- the script stamps the image with the release label it was
# resolved against). Fedora N carries GNOME N+6 (44 -> GNOME 50).
# Adapted from weatherglass's fedora.Containerfile.
#
# Everything the guest ladder needs: gnome-shell itself (zipcheck
# boots it headless via dbus-run-session, exactly like the host),
# gjs for the property tiers, python3 for the scripts' metadata
# reads, fonts for the painter previews.
ARG RELEASE=44
FROM quay.io/fedora/fedora:${RELEASE}

# EOL releases live only on dl.fedoraproject.org/archive; the stock
# metalink repos are graves. Swap in the archive baseurls before any
# dnf runs. Live releases keep their normal repos.
RUN if [ "${RELEASE}" -le 41 ]; then \
      sed -i 's|^metalink=|#metalink=|g; s|^baseurl=|#baseurl=|g' /etc/yum.repos.d/fedora*.repo; \
      printf '[fedora-archive]\nname=Fedora ${RELEASE} archive\nbaseurl=https://dl.fedoraproject.org/pub/archive/fedora/linux/releases/${RELEASE}/Everything/$basearch/os/\nenabled=1\ngpgcheck=1\ngpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-fedora-${RELEASE}-$basearch\n' > /etc/yum.repos.d/fedora-archive.repo; \
    fi

RUN dnf -y install \
      gnome-shell gjs python3 \
      zip unzip which procps-ng systemd dbus-daemon \
    && for f in 'font(Cantarell)' 'font(DejaVu Sans)' 'font(Noto Sans)' \
                'font(Liberation Sans)'; do \
         dnf -y install "$f" || echo "qa: optional font provide $f unavailable"; \
       done \
    && dnf clean all

# Recent shells activate org.freedesktop.portal.Desktop during init
# and abort when nobody owns the name -- the desktop host always had
# a portal; the guest must ship one. Separate layer: keeps the big
# tier-1 layer cached when the portal set churns.
RUN dnf -y install xdg-desktop-portal xdg-desktop-portal-gnome \
    && dnf clean all

# the nested shells speak the session bus only; give them a private
# runtime dir and never touch a real one
ENV XDG_RUNTIME_DIR=/tmp/qa-runtime
RUN mkdir -p /tmp/qa-runtime && chmod 700 /tmp/qa-runtime
