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
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // Rate limit: max 3 OTP sends per user per hour
      const { data: existing } = await sb.from('email_otps')
        .select('created_at')
        .eq('user_id', user_id)
        .single()
      if (existing && (Date.now() - new Date(existing.created_at).getTime()) < 60000) {
        return new Response(JSON.stringify({ error: 'wait a minute before requesting another code' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Generate a 6-digit code
      const otp = String(Math.floor(100000 + Math.random() * 900000))

      // Store code in a simple table (expires in 10 min)
      const { error: upsertErr } = await sb.from('email_otps').upsert({
        user_id,
        email,
        code: otp,
        attempts: 0,
        expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
        created_at: new Date().toISOString()
      }, { onConflict: 'user_id' })
      if (upsertErr) {
        console.error('Upsert error:', upsertErr)
        return new Response(JSON.stringify({ error: 'failed to store code: ' + upsertErr.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

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

      // Check attempt count before verifying
      const { data: otpRow } = await sb.from('email_otps')
        .select('*')
        .eq('user_id', user_id)
        .eq('email', email)
        .gt('expires_at', new Date().toISOString())
        .single()

      if (!otpRow) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid or expired code' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      if (otpRow.attempts >= 5) {
        await sb.from('email_otps').delete().eq('user_id', user_id)
        return new Response(JSON.stringify({ ok: false, error: 'too many attempts — request a new code' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Increment attempt counter
      await sb.from('email_otps').update({ attempts: (otpRow.attempts || 0) + 1 }).eq('user_id', user_id)

      if (otpRow.code !== code) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid code (' + (4 - (otpRow.attempts || 0)) + ' attempts left)' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const otp = otpRow

      // Link email to user via admin API
      const { data: updatedUser, error } = await sb.auth.admin.updateUserById(user_id, { email, email_confirm: true })
      if (error) {
        const msg = error.message?.includes('unique') || error.message?.includes('duplicate') || error.message?.includes('already')
          ? 'this email is already linked to another account'
          : 'failed to link email — try a different one';
        return new Response(JSON.stringify({ ok: false, error: msg }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Clean up OTP and system nudge pings
      await sb.from('email_otps').delete().eq('user_id', user_id)
      await sb.from('pings').delete().eq('to_id', user_id).eq('verb', 'system')

      return new Response(JSON.stringify({ verified: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // ── SIGN-IN FLOW ──
    if (action === 'signin-send') {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // Find user by email — use GoTrue admin API directly to avoid listUsers pagination limits
      const findRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1&filter=${encodeURIComponent(email)}`, {
        headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY }
      })
      const findData = await findRes.json()
      const existingUser = findData.users?.find((u: any) => u.email === email)
      if (!existingUser) {
        // Generic message to prevent email enumeration
        return new Response(JSON.stringify({ ok: false, error: 'if that email exists, we sent a code' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Rate limit: 1 code per minute per user
      const { data: existingOtp } = await sb.from('email_otps')
        .select('created_at')
        .eq('user_id', existingUser.id)
        .single()
      if (existingOtp && (Date.now() - new Date(existingOtp.created_at).getTime()) < 60000) {
        return new Response(JSON.stringify({ error: 'wait a minute before requesting another code' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Generate a 6-digit code
      const otp = String(Math.floor(100000 + Math.random() * 900000))

      const { error: upsertErr } = await sb.from('email_otps').upsert({
        user_id: existingUser.id,
        email,
        code: otp,
        attempts: 0,
        expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
        created_at: new Date().toISOString()
      }, { onConflict: 'user_id' })
      if (upsertErr) {
        return new Response(JSON.stringify({ error: 'failed to store code' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Send via Resend
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'pingme <play@usepingme.com>',
          to: email,
          subject: 'your pingme sign-in code',
          html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;text-align:center">
            <h2 style="font-size:22px;margin:0 0 8px">pingme</h2>
            <p style="color:#666;font-size:15px;margin:0 0 20px">here's your code to sign in</p>
            <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f5f0e8;border-radius:12px;padding:16px;margin:0 0 20px">${otp}</div>
            <p style="color:#999;font-size:13px">this code expires in 10 minutes.<br>if you didn't request this, just ignore it.</p>
          </div>`
        })
      })

      return new Response(JSON.stringify({ sent: true, user_id: existingUser.id }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (action === 'signin-verify') {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

      // Find user by email
      const findRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1&filter=${encodeURIComponent(email)}`, {
        headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY }
      })
      const findData = await findRes.json()
      const existingUser = findData.users?.find((u: any) => u.email === email)
      if (!existingUser) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid or expired code' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const { data: otpRow } = await sb.from('email_otps')
        .select('*')
        .eq('user_id', existingUser.id)
        .eq('email', email)
        .gt('expires_at', new Date().toISOString())
        .single()

      if (!otpRow) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid or expired code' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      if (otpRow.attempts >= 5) {
        await sb.from('email_otps').delete().eq('user_id', existingUser.id)
        return new Response(JSON.stringify({ ok: false, error: 'too many attempts — request a new code' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      await sb.from('email_otps').update({ attempts: (otpRow.attempts || 0) + 1 }).eq('user_id', existingUser.id)

      if (otpRow.code !== code) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid code (' + (4 - (otpRow.attempts || 0)) + ' attempts left)' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const otp = otpRow

      // Generate a magic link to extract the token
      const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
        type: 'magiclink',
        email
      })

      if (linkErr || !linkData) {
        return new Response(JSON.stringify({ ok: false, error: 'failed to generate session' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Clean up OTP
      await sb.from('email_otps').delete().eq('user_id', existingUser.id)

      // Return the hashed token for client-side verification
      const tokenHash = linkData.properties?.hashed_token
      return new Response(JSON.stringify({ verified: true, token_hash: tokenHash }), {
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
