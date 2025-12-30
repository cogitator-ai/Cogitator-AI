import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function POST() {
  const cookieStore = await cookies();

  cookieStore.delete('cogitator_token');
  cookieStore.delete('cogitator_refresh');

  return NextResponse.json({ success: true });
}
