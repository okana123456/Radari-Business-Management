import { createClient } from 'npm:@supabase/supabase-js@2'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const providedSecret = request.headers.get('x-cron-secret')
  if (!providedSecret || providedSecret !== Deno.env.get('CRON_SECRET')) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const supabase = adminClient()
    const { data: changed, error } = await supabase.rpc('refresh_subscription_statuses')
    if (error) throw error

    const { data: pendingReminders, error: reminderError } = await supabase
      .from('subscription_notifications')
      .select('id,business_id,notification_type,scheduled_for')
      .is('sent_at', null)
      .lte('scheduled_for', new Date().toISOString().slice(0, 10))
      .limit(500)
    if (reminderError) throw reminderError

    // A later notification provider can consume these pending records.
    // They remain unsent until delivery is confirmed.
    return json({ subscriptionsUpdated: changed || 0, pendingReminders: pendingReminders || [] })
  } catch (error) {
    return json({ error: error.message || 'Subscription maintenance failed' }, 500)
  }
})

