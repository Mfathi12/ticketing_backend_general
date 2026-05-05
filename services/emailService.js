const nodemailer = require('nodemailer');
console.log('Email User:', process.env.EMAIL_USER);
console.log('Email Pass:', process.env.EMAIL_PASS);
// Email configuration
// const transporter = nodemailer.createTransport({
//     host: 'smtp.gmail.com',
//   port: 465,
//   secure: true, // You can change this to your preferred email service
//     auth: {
//         user: "yo.abbas.absai@gmail.com",
//         pass: "qywz khgm hwex tnxi",
//     }
// });

const transporter = nodemailer.createTransport({
  host: "mail.absai.dev",
  port: 587,  // Use 587 with STARTTLS (recommended)
  secure: false,
    // true for 465, false for 587
  auth: {
    user: process.env.EMAIL_USER,  // tickets@absai.dev
    pass: process.env.EMAIL_PASS,  // Absaidev@12345,
  },
  tls: {
    rejectUnauthorized: false  // Accept self-signed certs (remove in production)
  }
});
transporter.verify(function(error, success) {
  if (error) {
    console.log('SMTP Error:', error);
  } else {
    console.log('Server is ready to send emails');
  }
});
async function sendTestEmail(to, subject, text, html) {
  try {
    const info = await transporter.sendMail({
      from: '"tik." <'+process.env.EMAIL_USER+'>',
      to: to,
      subject: subject,
      text: text,
      html: html,
    });
    
    console.log('Email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Email error:', error);
    return { success: false, error: error.message };
  }
}

// // Usage example
// sendTestEmail(
//   'yo.abbas.absai@gmail.com',
//   'Your Ticket #12345',
//   'Thank you for contacting us...',
//   '<h1>Thank you for contacting us</h1><p>Your ticket has been created.</p>'
// );

const sendEmail = async (to, subject, text, html, cc = null) => {
    try {
        const mailOptions = {
            from: '"tik." <'+process.env.EMAIL_USER+'>',
            to,
            subject,
            text,
            html
        };

        // Add CC if provided
        if (cc && cc.length > 0) {
            mailOptions.cc = Array.isArray(cc) ? cc.join(', ') : cc;
        }

        const result = await transporter.sendMail(mailOptions);
        console.log('Email sent successfully:', result.messageId);
        if (cc) {
            console.log('CC sent to:', mailOptions.cc);
        }
        return result;
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
};

const sendTicketNotification = async (senderEmail, receiverEmail, ticketData, action = 'created', ccEmails = []) => {
    const actionText = action === 'replied' ? 'New Reply Added' : `Ticket ${action.charAt(0).toUpperCase() + action.slice(1)}`;
    const subject = `${actionText} - ${ticketData.ticket || ticketData.n || 'N/A'}`;
    
    // Format comment/reply for display
    const commentSection = ticketData.receiver_comment ? `
        <div style="background-color: #e8f4f8; padding: 15px; border-left: 4px solid #2196F3; margin: 15px 0; border-radius: 4px;">
            <p style="margin: 0; font-weight: bold; color: #1976D2; margin-bottom: 8px;">
                ${action === 'replied' ? 'New Reply:' : 'Comment:'}
            </p>
            <p style="margin: 0; color: #333; white-space: pre-wrap;">${ticketData.receiver_comment}</p>
        </div>
    ` : '';
    
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333; border-bottom: 3px solid #2196F3; padding-bottom: 10px;">
                ${actionText}
            </h2>
            <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin-top: 20px;">
                <h3 style="color: #555; margin-top: 0;">Ticket Details:</h3>
                <p><strong>Ticket No.:</strong> ${ticketData.ticket || ticketData.n || 'N/A'}</p>
                <p><strong>From:</strong> ${ticketData.sender_title}</p>
                <p><strong>To:</strong> ${ticketData.receiver}</p>
                <p><strong>Description:</strong> ${ticketData.description}</p>
                <p><strong>Status:</strong> <span style="background-color: #e3f2fd; padding: 3px 8px; border-radius: 3px; font-weight: bold;">${ticketData.status}</span></p>
                <p><strong>Date:</strong> ${new Date(ticketData.date_of_issue).toLocaleDateString()}</p>
                ${commentSection}
                ${ccEmails && ccEmails.length > 0 ? `<p style="margin-top: 15px;"><strong>Handlers (CC):</strong> ${ccEmails.join(', ')}</p>` : ''}
            </div>
            ${action === 'replied' ? `
                <div style="margin-top: 20px; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                    <p style="margin: 0; color: #856404;">
                        <strong>Note:</strong> A new reply has been added to this ticket. Please log in to view and respond.
                    </p>
                </div>
            ` : ''}
        </div>
    `;

    const text = `
${actionText}

Ticket No.: ${ticketData.ticket || ticketData.n || 'N/A'}
From: ${ticketData.sender_title}
To: ${ticketData.receiver}
Description: ${ticketData.description}
Status: ${ticketData.status}
Date: ${new Date(ticketData.date_of_issue).toLocaleDateString()}
${ticketData.receiver_comment ? `${action === 'replied' ? 'New Reply:' : 'Comment:'}\n${ticketData.receiver_comment}\n` : ''}
${ccEmails && ccEmails.length > 0 ? `Handlers (CC): ${ccEmails.join(', ')}` : ''}
${action === 'replied' ? '\nNote: A new reply has been added to this ticket. Please log in to view and respond.' : ''}
    `;

    // Send to both sender and receiver with CC to handlers
    await Promise.all([
        sendEmail(senderEmail, subject, text, html, ccEmails),
        sendEmail(receiverEmail, subject, text, html, ccEmails)
    ]);
};

const sendRegistrationOTPEmail = async (email, otp, companyName) => {
    const subject = 'Verify your email — company registration';
    const safeName = companyName ? String(companyName).trim() : 'your company';
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Verify your email</h2>
            <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px;">
                <p>Thanks for registering <strong>${safeName}</strong>.</p>
                <p>Your verification code is:</p>
                <h1 style="color: #007bff; font-size: 32px; text-align: center;">${otp}</h1>
                <p>This code expires in 10 minutes.</p>
                <p style="font-size: 13px; color: #666;">If you did not create an account, you can ignore this message.</p>
            </div>
        </div>
    `;
    const text = `Verify your email for ${safeName}. Your code is: ${otp}. It expires in 10 minutes.`;
    await sendEmail(email, subject, text, html);
};

const sendOTPEmail = async (email, otp) => {
    const subject = 'Password Reset OTP';
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Password Reset OTP</h2>
            <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px;">
                <p>Your OTP for password reset is:</p>
                <h1 style="color: #007bff; font-size: 32px; text-align: center;">${otp}</h1>
                <p>This OTP will expire in 10 minutes.</p>
            </div>
        </div>
    `;

    const text = `Your OTP for password reset is: ${otp}. This OTP will expire in 10 minutes.`;

    await sendEmail(email, subject, text, html);
};

const sendUserInviteEmail = async ({
    email,
    invitedByName,
    companyName,
    inviteUrl,
    expiresInHours = 24
}) => {
    const subject = `You're invited to join ${companyName}`;
    const text = [
        `Hello,`,
        ``,
        `${invitedByName || 'A team admin'} invited you to join ${companyName}.`,
        `Set your password and activate your account using this link:`,
        inviteUrl,
        ``,
        `This invitation expires in ${expiresInHours} hours.`
    ].join('\n');

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
            <h2 style="color: #222;">You're invited to join ${companyName}</h2>
            <p>${invitedByName || 'A team admin'} added you as a team member.</p>
            <p>Click the button below to set your password and activate your account:</p>
            <p style="margin: 24px 0;">
                <a href="${inviteUrl}" style="background:#ff5a0a;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600;">
                    Accept Invitation
                </a>
            </p>
            <p style="font-size: 13px; color: #555;">If the button does not work, use this link:</p>
            <p style="font-size: 13px; word-break: break-all;">${inviteUrl}</p>
            <p style="font-size: 13px; color: #666;">This invitation expires in ${expiresInHours} hours.</p>
        </div>
    `;

    await sendEmail(email, subject, text, html);
};

module.exports = {
    sendEmail,
    sendTicketNotification,
    sendOTPEmail,
    sendRegistrationOTPEmail,
    sendUserInviteEmail
};
