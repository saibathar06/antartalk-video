CREATE SCHEMA IF NOT EXISTS antartalk_video;

CREATE TABLE IF NOT EXISTS antartalk_video.sessions (
    id text PRIMARY KEY,
    appointment_id text NOT NULL UNIQUE,
    doctor_id text NOT NULL,
    client_id text NOT NULL,
    opens_at timestamptz NOT NULL,
    closes_at timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'ended', 'cancelled')),
    created_at timestamptz NOT NULL,
    ended_at timestamptz,
    overlap_started_at timestamptz,
    overlap_ms bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS antartalk_video.credentials (
    digest text PRIMARY KEY,
    session_id text NOT NULL REFERENCES antartalk_video.sessions(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('ticket', 'connection')),
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS credentials_session
    ON antartalk_video.credentials(session_id, user_id, kind);

CREATE TABLE IF NOT EXISTS antartalk_video.attendance (
    session_id text NOT NULL REFERENCES antartalk_video.sessions(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('doctor', 'client')),
    first_joined_at timestamptz,
    last_joined_at timestamptz,
    last_left_at timestamptz,
    total_connected_ms bigint NOT NULL DEFAULT 0,
    join_count integer NOT NULL DEFAULT 0,
    connected boolean NOT NULL DEFAULT false,
    PRIMARY KEY (session_id, role)
);
