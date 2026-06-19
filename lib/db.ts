import { nanoid } from 'nanoid'
import { getDb } from '@/lib/mongo'

type User = { id: string; email: string; passwordHash: string; createdAt: number }
type Session = { id: string; userId: string; createdAt: number; expiresAt: Date }
type Project = { id: string; userId: string; sandboxId: string; url: string; name?: string; createdAt: number; updatedAt: number }

export async function getUserByEmail(email: string): Promise<User | undefined> {
  const db = await getDb()
  const doc = await db.collection<User>('users').findOne({ email: email.toLowerCase() })
  return doc || undefined
}

export async function getUserById(id: string): Promise<User | undefined> {
  const db = await getDb()
  const doc = await db.collection<User>('users').findOne({ id })
  return doc || undefined
}

export async function createUser(email: string, passwordHash: string): Promise<User> {
  const db = await getDb()
  const user: User = { id: nanoid(), email: email.toLowerCase(), passwordHash, createdAt: Date.now() }
  await db.collection<User>('users').insertOne({ _id: user.id as any, ...user } as any)
  return user
}

export async function createSession(userId: string, ttlHours = 72): Promise<Session> {
  const db = await getDb()
  const session: Session = {
    id: nanoid(),
    userId,
    createdAt: Date.now(),
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000)
  }
  await db.collection<Session>('sessions').insertOne({ _id: session.id as any, ...session } as any)
  return session
}

export async function getSession(id: string): Promise<Session | undefined> {
  const db = await getDb()
  const doc = await db.collection<Session>('sessions').findOne({ id })
  if (!doc || doc.expiresAt.getTime() <= Date.now()) return undefined
  return doc
}

export async function deleteSession(id: string) {
  const db = await getDb()
  await db.collection<Session>('sessions').deleteOne({ id })
}

export async function getProjectsByUser(userId: string): Promise<Project[]> {
  const db = await getDb()
  const cursor = db.collection<Project>('projects')
    .find({ userId })
    .sort({ updatedAt: -1 })
  return await cursor.toArray()
}

export async function upsertProject(userId: string, sandboxId: string, url: string, name?: string): Promise<Project> {
  const db = await getDb()
  const now = Date.now()
  const update = {
    $set: { userId, sandboxId, url, updatedAt: now },
    $setOnInsert: { id: nanoid(), name, createdAt: now }
  }
  const result = await db.collection<Project>('projects').findOneAndUpdate(
    { userId, sandboxId },
    update,
    { upsert: true, returnDocument: 'after' }
  )
  // Mongo can return null pre-insert; re-fetch to be safe
  const doc = result || await db.collection<Project>('projects').findOne({ userId, sandboxId })
  return doc as Project
}
