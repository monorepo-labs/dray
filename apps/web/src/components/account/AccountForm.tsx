"use client";

import { useState, useTransition } from "react";

import { saveAccount } from "@/app/app/account/actions";
import { usernameProblem } from "@/lib/slug";

import { ERROR, INPUT, LABEL, MUTED, PRIMARY } from "./styles";

const PREFIX = `flex items-center border border-r-0 border-white/20 px-3 text-[14px] light:border-black/15 ${MUTED}`;

/// The reader's own name and username, with their email shown but fixed.
export function AccountForm({ user }: { user: { name: string; email: string; username: string } }) {
  const [name, setName] = useState(user.name);
  const [username, setUsername] = useState(user.username);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const unchanged = name.trim() === user.name && username === user.username;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = usernameProblem(username);
    if (problem) return setError(problem);
    start(async () => {
      const failed = await saveAccount({ name, username });
      setError(failed);
      setSaved(!failed);
    });
  };

  return (
    <form onSubmit={submit} className="mt-8 flex flex-col gap-5">
      <label className="flex flex-col gap-2">
        <span className={LABEL}>Name</span>
        <input
          value={name}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          className={INPUT}
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className={LABEL}>Username</span>
        <div className="flex items-stretch">
          <span className={PREFIX}>@</span>
          <input
            value={username}
            maxLength={20}
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => {
              setUsername(e.target.value.toLowerCase());
              setSaved(false);
            }}
            className={INPUT}
          />
        </div>
        <span className={`text-[13px] ${MUTED}`}>3–20 lowercase letters, digits or underscores.</span>
      </label>
      <label className="flex flex-col gap-2">
        <span className={LABEL}>Email</span>
        <input value={user.email} disabled className={INPUT} />
        <span className={`text-[13px] ${MUTED}`}>From your Google account.</span>
      </label>
      {error && <p className={ERROR}>{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending || unchanged} className={PRIMARY}>
          Save
        </button>
        {saved && unchanged && <span className={`text-[13px] ${MUTED}`}>Saved.</span>}
      </div>
    </form>
  );
}
