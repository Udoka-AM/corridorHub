export const SCHEMA = /* sql */ `
create table if not exists accounts (
  id           text primary key,
  type         text not null check (type in ('asset','liability','revenue','expense','clearing','equity')),
  owner_type   text not null,
  owner_id     text not null,
  corridor     text,
  asset        text not null,
  venue        text not null,
  no_overdraft boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists journal_entries (
  id             uuid primary key,
  created_at     timestamptz not null default now(),
  kind           text not null,
  saga_id        text,
  reference      text,
  external_venue text,
  external_ref   text,
  metadata       jsonb not null default '{}'::jsonb,
  unique (external_venue, external_ref)
);
create index if not exists journal_entries_reference on journal_entries (reference);

create table if not exists postings (
  id         bigserial primary key,
  entry_id   uuid not null references journal_entries (id),
  account_id text not null references accounts (id),
  asset      text not null,
  direction  char(1) not null check (direction in ('D','C')),
  amount     numeric(78,0) not null check (amount > 0)
);
create index if not exists postings_entry on postings (entry_id);
create index if not exists postings_account on postings (account_id);

-- Projection maintained in the same transaction as each posting.
create table if not exists balances (
  account_id text primary key references accounts (id),
  asset      text not null,
  debits     numeric(78,0) not null default 0,
  credits    numeric(78,0) not null default 0
);

-- The journal is append-only.
create or replace function corridor_reject_mutation() returns trigger as $$
begin
  raise exception 'journal is append-only: % on % is not allowed', tg_op, tg_table_name;
end;
$$ language plpgsql;

drop trigger if exists journal_entries_immutable on journal_entries;
create trigger journal_entries_immutable before update or delete on journal_entries
  for each row execute function corridor_reject_mutation();

drop trigger if exists postings_immutable on postings;
create trigger postings_immutable before update or delete on postings
  for each row execute function corridor_reject_mutation();
`;
