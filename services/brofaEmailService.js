const nodemailer = require('nodemailer');

// Email configuration without authentication
const transporter = nodemailer.createTransport({
    host: "mail.absai.dev",
    port: 587,  // Use 587 with STARTTLS (recommended)
    secure: false,  // true for 465, false for 587
    auth: {
      user: "tickets@absai.dev",  // tickets@absai.dev
      pass: "absai@12345"  // Absaidev@12345,
    },
    tls: {
      rejectUnauthorized: false  // Accept self-signed certs (remove in production)
    }
  });

// Verify transporter connection
transporter.verify(function(error, success) {
  if (error) {
    console.log('SMTP Error:', error);
  } else {
    console.log('Brofa Email Server is ready to send emails');
  }
});

// Send user question to brofa@absai.dev
const sendUserQuestion = async (userData) => {
    try {
        const { 
            name, 
            email, 
            phoneNumber, 
            businessCategory, 
            brandName, 
            serviceType, 
            message 
        } = userData;
        
        const subject = `New Inquiry from ${brandName} - ${serviceType}`;
        
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #333;">New Inquiry from Profa App</h2>
                <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px;">
                    <h3 style="color: #333; margin-top: 0;">Contact Information:</h3>
                    <p><strong>Name:</strong> ${name}</p>
                    ${email ? `<p><strong>Email:</strong> ${email}</p>` : ''}
                    <p><strong>Phone Number:</strong> ${phoneNumber}</p>
                    <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                    
                    <hr style="border: 1px solid #ddd; margin: 20px 0;">
                    
                    <h3 style="color: #333;">Business Details:</h3>
                    <p><strong>Brand Name:</strong> ${brandName}</p>
                    <p><strong>Business Category:</strong> ${businessCategory}</p>
                    <p><strong>Service Type:</strong> ${serviceType}</p>
                    
                    ${message ? `
                    <hr style="border: 1px solid #ddd; margin: 20px 0;">
                    <h3 style="color: #333;">Message:</h3>
                    <p style="white-space: pre-wrap; background-color: #fff; padding: 15px; border-radius: 3px;">${message}</p>
                    ` : ''}
                </div>
            </div>
        `;

        const text = `
            New Inquiry from Profa App
            
            Contact Information:
            Name: ${name}
            ${email ? `Email: ${email}` : ''}
            Phone Number: ${phoneNumber}
            Date: ${new Date().toLocaleString()}
            
            Business Details:
            Brand Name: ${brandName}
            Business Category: ${businessCategory}
            Service Type: ${serviceType}
            
            ${message ? `Message:\n${message}` : ''}
        `;

        const mailOptions = {
            from: "tickets@absai.dev",
            to: "brofa@absai.dev",
            replyTo: email || "tickets@absai.dev",
            subject: subject,
            text: text,
            html: html
        };

        const result = await transporter.sendMail(mailOptions);
        console.log('Question email sent successfully to brofa@absai.dev:', result.messageId);
        return { success: true, messageId: result.messageId };
    } catch (error) {
        console.error('Error sending question email:', error);
        throw error;
    }
};

// Generic send email function (if needed)
const sendEmail = async (to, subject, text, html) => {
    try {
        const mailOptions = {
            from: "noreply@absai.dev",
            to,
            subject,
            text,
            html
        };

        const result = await transporter.sendMail(mailOptions);
        console.log('Email sent successfully:', result.messageId);
        return result;
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
};

module.exports = {
    sendUserQuestion,
    sendEmail
};

