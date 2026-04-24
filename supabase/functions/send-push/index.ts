import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'https://esm.sh/web-push@3.6.7'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!
    const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    webpush.setVapidDetails('mailto:pingme@noreply.app', VAPID_PUBLIC, VAPID_PRIVATE)

    const body = await req.json()
    // Support both webhook format and direct call
    const record = body.record || body

    if (!record.to_id || !record.from_id) {
      return new Response(JSON.stringify({ error: 'missing to_id or from_id' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Get push subscription for recipient
    const { data: sub } = await sb
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', record.to_id)
      .single()

    if (!sub) {
      return new Response(JSON.stringify({ status: 'no subscription' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Get sender name
    const { data: sender } = await sb
      .from('profiles')
      .select('name')
      .eq('id', record.from_id)
      .single()

    const payload = JSON.stringify({
      title: 'pingme',
      body: record.msg || ((sender?.name || 'someone') + ' wants to play!')
    })

    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth }
    }

    await webpush.sendNotification(pushSub, payload)

    return new Response(JSON.stringify({ status: 'sent' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (e: any) {
    console.error('Push error:', e)
    // 410 = subscription expired, clean it up
    if (e.statusCode === 410) {
      try {
        const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
        const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        const body = await req.clone().json().catch(() => ({}))
        const record = body.record || body
        if (record.to_id) {
          await sb.from('push_subscriptions').delete().eq('user_id', record.to_id)
        }
      } catch {}
      return new Response(JSON.stringify({ status: 'subscription expired, cleaned up' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
