#!/usr/bin/env bash
set -e

# Launch Home Assistant Matter Server container on Raspberry Pi
# Uses host networking to enable IPv6 multicast/mDNS and standard Matter port 5540.

CONTAINER_NAME="matter-server"
DATA_DIR="${MATTER_DATA_DIR:-/home/rohan/matter-server}"
IMAGE="ghcr.io/home-assistant-libs/python-matter-server:stable"

echo "Checking $CONTAINER_NAME container status..."

if [ "$(docker ps -q -f name=^/${CONTAINER_NAME}$)" ]; then
    echo "✅ $CONTAINER_NAME is already running."
    exit 0
fi

if [ "$(docker ps -aq -f status=exited -f name=^/${CONTAINER_NAME}$)" ]; then
    echo "🔄 Starting stopped $CONTAINER_NAME container..."
    docker start "$CONTAINER_NAME"
    exit 0
fi

echo "🚀 Launching new $CONTAINER_NAME container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart=unless-stopped \
  --security-opt apparmor=unconfined \
  -v "$DATA_DIR":/data \
  -v /run/dbus:/run/dbus:ro \
  --network=host \
  "$IMAGE"

echo "✅ $CONTAINER_NAME launched successfully on host network (port 5580)."
