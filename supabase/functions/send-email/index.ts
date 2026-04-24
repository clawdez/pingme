import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  try {
    const { action, email, code, user_id } = await req.json()

    if (action === 'send') {
      // Generate a 6-digit code
      const otp = String(Math.floor(100000 + Math.random() * 900000))

      // Store code in a simple table (expires in 10 min)
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
      await sb.from('email_otps').upsert({
        user_id,
        email,
        code: otp,
        expires_at: new Date(Date.now() + 10 * 60000).toISOString()
      }, { onConflict: 'user_id' })

      // Send via Resend HTTP API
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'pingme <play@usepingme.com>',
          to: email,
          subject: 'your pingme code',
          html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;text-align:center">
            <h2 style="font-size:22px;margin:0 0 8px">pingme</h2>
            <p style="color:#666;font-size:15px;margin:0 0 20px">here's your code to link your email</p>
            <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f5f0e8;border-radius:12px;padding:16px;margin:0 0 20px">${otp}</div>
            <p style="color:#999;font-size:13px">this code expires in 10 minutes.<br>if you didn't request this, just ignore it.</p>
          </div>`
        })
      })

      const result = await res.json()
      if (!res.ok) {
        return new Response(JSON.stringify({ error: 'email failed' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      return new Response(JSON.stringify({ sent: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (action === 'verify') {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      const { data: otp } = await sb.from('email_otps')
        .select('*')
        .eq('user_id', user_id)
        .eq('email', email)
        .eq('code', code)
        .gt('expires_at', new Date().toISOString())
        .single()

      if (!otp) {
        return new Response(JSON.stringify({ error: 'invalid or expired code' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Link email to user via admin API
      const { error } = await sb.auth.admin.updateUserById(user_id, { email, email_confirm: true })
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Clean up OTP and system nudge pings
      await sb.from('email_otps').delete().eq('user_id', user_id)
      await sb.from('pings').delete().eq('to_id', user_id).eq('verb', 'system')

      return new Response(JSON.stringify({ verified: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ error: 'unknown action' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (e) {
    console.error('Error:', e)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
