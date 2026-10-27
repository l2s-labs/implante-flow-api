-- L2S-72: cache ViaCEP (global; app não chama ViaCEP)
-- Branch: stage only. Commit: feat(db): add cep_cache for ViaCEP lookups

CREATE TABLE cep_cache (
  cep char(8) PRIMARY KEY CHECK (cep ~ '^[0-9]{8}$'),
  street text NOT NULL DEFAULT '',
  neighborhood text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  state char(2) NOT NULL DEFAULT '' CHECK (state = '' OR state ~ '^[A-Z]{2}$'),
  ibge text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'viacep',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER cep_cache_updated_at BEFORE UPDATE ON cep_cache
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cache compartilhado entre dentistas: sem RLS de tenant.
ALTER TABLE cep_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE cep_cache FORCE ROW LEVEL SECURITY;

CREATE POLICY cep_cache_read ON cep_cache
  FOR SELECT TO implante_app
  USING (true);

CREATE POLICY cep_cache_write ON cep_cache
  FOR INSERT TO implante_app
  WITH CHECK (true);

CREATE POLICY cep_cache_update ON cep_cache
  FOR UPDATE TO implante_app
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON cep_cache TO implante_app;
-- Sem DELETE: CEP inexistente não grava; invalidação = UPDATE se ViaCEP mudar.
