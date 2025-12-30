import { query, queryOne, execute } from '../db/index';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { nanoid } from 'nanoid';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  role: 'admin' | 'user' | 'readonly';
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserData {
  id: string;
  email: string;
  role: 'admin' | 'user' | 'readonly';
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

function hashPassword(password: string, salt: string): string {
  return createHash('sha256')
    .update(password + salt)
    .digest('hex');
}

function verifyPassword(password: string, hash: string, salt: string): boolean {
  const computedHash = hashPassword(password, salt);
  const hashBuffer = Buffer.from(hash, 'hex');
  const computedBuffer = Buffer.from(computedHash, 'hex');

  if (hashBuffer.length !== computedBuffer.length) return false;
  return timingSafeEqual(hashBuffer, computedBuffer);
}

export async function initializeUsersSchema(): Promise<void> {
  await execute(`
    CREATE TABLE IF NOT EXISTS cogitator_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'readonly')),
      is_active BOOLEAN DEFAULT true,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cogitator_users_email ON cogitator_users(email);
  `);
}

export async function createUser(data: {
  email: string;
  password: string;
  role?: 'admin' | 'user' | 'readonly';
}): Promise<UserData> {
  const id = `user_${nanoid(12)}`;
  const salt = randomBytes(16).toString('hex');
  const passwordHash = hashPassword(data.password, salt);

  await execute(
    `INSERT INTO cogitator_users (id, email, password_hash, salt, role)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, data.email, passwordHash, salt, data.role || 'user']
  );

  return {
    id,
    email: data.email,
    role: data.role || 'user',
    isActive: true,
    createdAt: new Date().toISOString(),
  };
}

export async function authenticateUser(
  email: string,
  password: string
): Promise<UserData | null> {
  const user = await queryOne<UserRow>(
    'SELECT * FROM cogitator_users WHERE email = $1 AND is_active = true',
    [email]
  );

  if (!user) return null;
  if (!verifyPassword(password, user.password_hash, user.salt)) return null;

  await execute(
    'UPDATE cogitator_users SET last_login_at = NOW() WHERE id = $1',
    [user.id]
  );

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.is_active,
    lastLoginAt: new Date().toISOString(),
    createdAt: user.created_at.toISOString(),
  };
}

export async function getUserById(id: string): Promise<UserData | null> {
  const user = await queryOne<UserRow>(
    'SELECT * FROM cogitator_users WHERE id = $1',
    [id]
  );

  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.is_active,
    lastLoginAt: user.last_login_at?.toISOString(),
    createdAt: user.created_at.toISOString(),
  };
}

export async function getUsers(): Promise<UserData[]> {
  const users = await query<UserRow>(
    'SELECT * FROM cogitator_users ORDER BY created_at DESC'
  );

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    role: u.role,
    isActive: u.is_active,
    lastLoginAt: u.last_login_at?.toISOString(),
    createdAt: u.created_at.toISOString(),
  }));
}

export async function updateUserRole(
  id: string,
  role: 'admin' | 'user' | 'readonly'
): Promise<boolean> {
  const count = await execute(
    'UPDATE cogitator_users SET role = $1, updated_at = NOW() WHERE id = $2',
    [role, id]
  );
  return count > 0;
}

export async function deactivateUser(id: string): Promise<boolean> {
  const count = await execute(
    'UPDATE cogitator_users SET is_active = false, updated_at = NOW() WHERE id = $1',
    [id]
  );
  return count > 0;
}

export async function changePassword(
  id: string,
  newPassword: string
): Promise<boolean> {
  const salt = randomBytes(16).toString('hex');
  const passwordHash = hashPassword(newPassword, salt);

  const count = await execute(
    'UPDATE cogitator_users SET password_hash = $1, salt = $2, updated_at = NOW() WHERE id = $3',
    [passwordHash, salt, id]
  );
  return count > 0;
}

export async function ensureDefaultAdmin(): Promise<void> {
  const adminEmail = process.env.COGITATOR_ADMIN_EMAIL || 'admin@cogitator.local';
  const adminPassword = process.env.COGITATOR_ADMIN_PASSWORD || 'admin';

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM cogitator_users WHERE email = $1',
    [adminEmail]
  );

  if (!existing) {
    await createUser({
      email: adminEmail,
      password: adminPassword,
      role: 'admin',
    });
    console.log(`[auth] Default admin user created: ${adminEmail}`);
  }
}
