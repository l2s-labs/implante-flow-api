-- L2S-74: follow-up de prótese (provisório + definitivo)
-- Branch: stage only. Commit: feat(db): prosthesis follow-up phases and status chain

CREATE TABLE prosthesis_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dentist_id uuid NOT NULL,
  procedure_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('provisorio', 'definitivo')),
  -- provisório: só a fase (status NULL)
  -- definitivo: moldado → enviadoLaboratorio → retornoLaboratorio → instalada (pode pular)
  status text CHECK (
    status IS NULL
    OR status IN (
      'moldado',
      'enviadoLaboratorio',
      'retornoLaboratorio',
      'instalada'
    )
  ),
  status_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dentist_id, id),
  UNIQUE (procedure_id, phase),
  FOREIGN KEY (dentist_id, procedure_id) REFERENCES procedures (dentist_id, id),
  CHECK (
    (phase = 'provisorio' AND status IS NULL)
    OR (phase = 'definitivo')
  )
);

CREATE INDEX prosthesis_followups_procedure_idx
  ON prosthesis_followups (dentist_id, procedure_id);

CREATE TRIGGER prosthesis_followups_updated_at BEFORE UPDATE ON prosthesis_followups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Histórico opcional: cada status gravado (pular etapas = não inserir os pulados)
CREATE TABLE prosthesis_followup_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dentist_id uuid NOT NULL,
  followup_id uuid NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'moldado',
      'enviadoLaboratorio',
      'retornoLaboratorio',
      'instalada'
    )
  ),
  status_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dentist_id, id),
  FOREIGN KEY (dentist_id, followup_id)
    REFERENCES prosthesis_followups (dentist_id, id) ON DELETE CASCADE
);

CREATE INDEX prosthesis_followup_events_followup_idx
  ON prosthesis_followup_status_events (dentist_id, followup_id, created_at);

ALTER TABLE prosthesis_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE prosthesis_followups FORCE ROW LEVEL SECURITY;
ALTER TABLE prosthesis_followup_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE prosthesis_followup_status_events FORCE ROW LEVEL SECURITY;

CREATE POLICY prosthesis_followups_isolation ON prosthesis_followups
  USING (dentist_id = NULLIF(current_setting('app.dentist_id', true), '')::uuid)
  WITH CHECK (dentist_id = NULLIF(current_setting('app.dentist_id', true), '')::uuid);

CREATE POLICY prosthesis_followup_status_events_isolation ON prosthesis_followup_status_events
  USING (dentist_id = NULLIF(current_setting('app.dentist_id', true), '')::uuid)
  WITH CHECK (dentist_id = NULLIF(current_setting('app.dentist_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  prosthesis_followups, prosthesis_followup_status_events
TO implante_app;

-- Sem campos de laboratório/valor nesta entrega (L2S-74).
