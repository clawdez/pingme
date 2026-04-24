import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

serve(async (req: Request) => {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!

  try {
    const payload = await req.json()
    const { user, email_data } = payload

    const toEmail = user.email || email_data.email_address
    if (!toEmail) {
      return new Response(JSON.stringify({ error: 'no email address' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }

    const token = email_data.token
    const redirectTo = email_data.redirect_to || ''
    const emailType = email_data.email_action_type

    let subject = 'your pingme code'
    let html = ''

    if (emailType === 'magic_link' || emailType === 'signup') {
      subject = 'your pingme code'
      html = `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;text-align:center">
        <h2 style="font-size:22px;margin:0 0 8px">pingme</h2>
        <p style="color:#666;font-size:15px;margin:0 0 20px">here's your code to get in</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f5f0e8;border-radius:12px;padding:16px;margin:0 0 20px">${token}</div>
        <p style="color:#999;font-size:13px">this code expires in 10 minutes.<br>if you didn't request this, just ignore it.</p>
      </div>`
    } else if (emailType === 'email_change') {
      subject = 'your pingme code'
      html = `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;text-align:center">
        <h2 style="font-size:22px;margin:0 0 8px">pingme</h2>
        <p style="color:#666;font-size:15px;margin:0 0 20px">here's your code to link your email</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f5f0e8;border-radius:12px;padding:16px;margin:0 0 20px">${token}</div>
        <p style="color:#999;font-size:13px">this code expires in 10 minutes.<br>if you didn't request this, just ignore it.</p>
      </div>`
    } else {
      // Default for any other email type
      subject = 'pingme notification'
      html = `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;text-align:center">
        <h2 style="font-size:22px;margin:0 0 8px">pingme</h2>
        <p style="color:#666;font-size:15px;margin:0 0 20px">${email_data.token_hash ? 'your verification code' : 'notification'}</p>
        ${token ? `<div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f5f0e8;border-radius:12px;padding:16px;margin:0 0 20px">${token}</div>` : ''}
        ${email_data.confirmation_url ? `<p><a href="${email_data.confirmation_url}" style="display:inline-block;background:#E8502A;color:#fff;font-weight:700;font-size:16px;padding:12px 32px;border-radius:12px;text-decoration:none">confirm</a></p>` : ''}
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
        status: 500, headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })
  } catch (e) {
    console.error('Send email error:', e)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
})
