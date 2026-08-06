#!/usr/bin/env bash
set -e

# Monga Cal — Raspberry Pi PostgreSQL Bootstrap Script
# Run this script on your Raspberry Pi to set up database permissions and create initial tables.

DB_NAME="monga_cal"
DB_USER="pi"

echo "=================================================="
echo "🚀 Bootstrapping PostgreSQL for Monga Cal on Pi"
echo "=================================================="

# 1. Grant schema privileges and set schema ownership for 'pi'
sudo -u postgres psql -d "$DB_NAME" <<EOF
-- Grant schema ownership and create permissions to user '$DB_USER'
GRANT ALL ON SCHEMA public TO $DB_USER;
ALTER SCHEMA public OWNER TO $DB_USER;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO $DB_USER;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO $DB_USER;
EOF

echo "✅ Granted schema permissions to user '$DB_USER' on database '$DB_NAME'."

# 2. Bootstrap tables directly
sudo -u postgres psql -d "$DB_NAME" <<EOF
CREATE TABLE IF NOT EXISTS task_history (
    id SERIAL PRIMARY KEY,
    task_id TEXT,
    title TEXT NOT NULL,
    estimated_minutes INTEGER NOT NULL,
    actual_minutes INTEGER NOT NULL,
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_task_history_completed ON task_history(completed_at DESC);

CREATE TABLE IF NOT EXISTS estimate_cache (
    content_hash TEXT PRIMARY KEY,
    estimated_minutes INTEGER,
    priority_score INTEGER,
    energy_level TEXT,
    manager_directive TEXT,
    reasoning TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plan_history (
    id SERIAL PRIMARY KEY,
    plan_hash TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_deferrals (
    task_id TEXT PRIMARY KEY,
    deferred_until DATE NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS priority_overrides (
    task_id TEXT PRIMARY KEY,
    priority_score INTEGER NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ensure user '$DB_USER' owns all created tables
ALTER TABLE task_history OWNER TO $DB_USER;
ALTER TABLE estimate_cache OWNER TO $DB_USER;
ALTER TABLE plan_history OWNER TO $DB_USER;
ALTER TABLE task_deferrals OWNER TO $DB_USER;
ALTER TABLE priority_overrides OWNER TO $DB_USER;
ALTER TABLE app_settings OWNER TO $DB_USER;
EOF

echo "=================================================="
echo "🎉 PostgreSQL Bootstrap Complete for Monga Cal!"
echo "User '$DB_USER' has full table access on database '$DB_NAME'."
echo "=================================================="
