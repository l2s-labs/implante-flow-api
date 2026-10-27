-- L2S-73: soft delete de procedimento
-- Branch: stage only. Commit: feat(db): soft-delete procedures via deleted_at

ALTER TABLE procedures
  ADD COLUMN deleted_at timestamptz;

CREATE INDEX procedures_active_idx
  ON procedures (dentist_id, patient_id, surgery_date DESC)
  WHERE deleted_at IS NULL;

-- Listagens padrão da API: WHERE deleted_at IS NULL.
-- RLS dentist_id inalterado (só dono vê/atualiza).
-- Filhos (tooth_sites, visits, …) permanecem; sumir do app = filtrar o pai.
-- Sem hard delete nesta entrega.
