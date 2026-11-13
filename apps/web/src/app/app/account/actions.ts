"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { auth, isTaken } from "@/lib/auth";
import { pool } from "@/lib/db";
import { usernameProblem } from "@/lib/slug";

/// Saves the reader's name and username. Email stays as Google gave it.
export async function saveAccount(input: { name: string; username: string }): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return "Sign in again.";
  const name = input.name.trim();
  const username = input.username.trim().toLowerCase();
  if (!name) return "Your name can't be empty.";
  if (name.length > 80) return "Keep your name under 80 characters.";
  const problem = usernameProblem(username);
  if (problem) return problem;
  try {
    await pool.query(`update "user" set name = $1, username = $2, "updatedAt" = now() where id = $3`, [
      name,
      username,
      session.user.id,
    ]);
  } catch (e) {
    if (isTaken(e)) return `@${username} is taken.`;
    throw e;
  }
  revalidatePath("/app", "layout");
  return null;
}
