import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, webhook-id, webhook-timestamp, webhook-signature',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!

  try {
    const payload = await req.json()
    const { user, email_data } = payload

    const toEmail = email_data?.email_address || user?.email
    if (!toEmail) {
      return new Response(JSON.stringify({ error: 'no email address' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const token = email_data?.token || ''
    const emailType = email_data?.email_action_type || ''

    let subject = 'your pingme code'
    let html = ''

    if (emailType === 'magic_link' || emailType === 'signup') {
      html = `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;text-align:center">
        <h2 style="font-size:22px;margin:0 0 8px">pingme</h2>
        <p style="color:#666;font-size:15px;margin:0 0 20px">here's your code to get in</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f5f0e8;border-radius:12px;padding:16px;margin:0 0 20px">${token}</div>
        <p style="color:#999;font-size:13px">this code expires in 10 minutes.<br>if you didn't request this, just ignore it.</p>
      </div>`
    } else if (emailType === 'email_change') {
      html = `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;text-align:center">
        <h2 style="font-size:22px;margin:0 0 8px">pingme</h2>
        <p style="color:#666;font-size:15px;margin:0 0 20px">here's your code to link your email</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f5f0e8;border-radius:12px;padding:16px;margin:0 0 20px">${token}</div>
        <p style="color:#999;font-size:13px">this code expires in 10 minutes.<br>if you didn't request this, just ignore it.</p>
      </div>`
    } else {
      html = `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;text-align:center">
        <h2 style="font-size:22px;margin:0 0 8px">pingme</h2>
        ${token ? `<div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f5f0e8;border-radius:12px;padding:16px;margin:0 0 20px">${token}</div>` : '<p>notification from pingme</p>'}
      </div>`
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'pingme <play@usepingme.com>',
        to: toEmail,
        subject,
        html
      })
    })

    const result = await res.json()
    if (!res.ok) {
      console.error('Resend error:', result)
      return new Response(JSON.stringify({ error: result }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (e) {
    console.error('Send email error:', e)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
