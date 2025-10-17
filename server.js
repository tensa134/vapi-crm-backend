const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
app.use(express.text({ type: '*/*' }));

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function getPhoneNumberFromMessage(message) {
    const sipUri = message?.customer?.sipUri || message?.call?.customer?.number || message?.call?.customer?.sipUri;
    if (!sipUri) return null;
    let number = sipUri;
    if (number.startsWith('sip:')) {
        const atIndex = number.indexOf('@');
        if (atIndex !== -1) number = number.substring(4, atIndex);
    }
    return number;
}

function sanitizeValue(value) {
    const nullValues = ["N/A", "Unknown", "Uncertain"];
    if (nullValues.includes(value)) {
        return "";
    }
    return value;
}

async function sendToExternalCRM(data) {
    const url = 'https://indiavoice.rpdigitalphone.com/api_v2/savecontact_v2';
    const authcode = process.env.EXTERNAL_CRM_AUTHCODE;

    if (!authcode) {
        console.error('EXTERNAL_CRM_AUTHCODE is not set in environment variables. Skipping send.');
        return;
    }

    const formData = new FormData();
    
    formData.append('authcode', authcode);
    formData.append('contact_num', data.contact_num);
    formData.append('contact_name', data.contact_name);
    formData.append('contact_address', data.city && data.state ? `${data.city}, ${data.state}` : data.city || data.state);
    formData.append('contact_status', data.contact_status);
    formData.append('contact_followuptime', data.contact_followuptime);
    formData.append('contact_followupdate', data.contact_followupdate);
    formData.append('extra_param', data.extra_param);
    formData.append('contact_comment', data.contact_comment);

    try {
        console.log('Sending sanitized data to external CRM as form-data...');
        const response = await fetch(url, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`External CRM API request failed with status ${response.status} and body: ${await response.text()}`);
        }

        const responseData = await response.json();
        console.log('Successfully sent data to external CRM. Response:', responseData);
    } catch (error) {
        console.error('Error sending data to external CRM:', error);
    }
}

app.post('/api/handler', async (req, res) => {
    let parsedBody;
    try {
        if (typeof req.body === 'string' && req.body.length > 0) {
            parsedBody = JSON.parse(req.body);
        } else {
             return res.status(200).send();
        }
    } catch (e) {
        return res.status(400).send('Invalid JSON');
    }
    
    const message = parsedBody.message || parsedBody;

    if (!message || !message.type) {
        return res.status(200).send();
    }

    if (message.type === 'tool-call' && message.toolCall.name === 'databasecheck') {
        // This logic can be removed if the tool is no longer used in the prompt.
        // For now, it remains harmless.
    }

    if (message.type === 'end-of-call-report') {
        console.log("--- RUNNING LATEST BILINGUAL SERVER CODE ---");
        const callerPhoneNumber = getPhoneNumberFromMessage(message);

        if (!callerPhoneNumber) {
            return res.status(200).send();
        }

        try {
            const summary = message?.analysis?.summary || message?.summary || 'No summary available.';
            const transcript = message?.artifact?.transcript || message?.transcript || '';
            
            const analysis = await analyzeCallSummary(summary, transcript);

            const extraParamString = [
                sanitizeValue(analysis['User Type']),
                sanitizeValue(analysis.course),
                sanitizeValue(analysis.city),
                sanitizeValue(analysis.state),
                'Incoming',
                sanitizeValue(analysis['Lead Status']),
            ].join('$');

            const fullCrmData = {
                'contact_num': sanitizeValue(callerPhoneNumber),
                'contact_name': sanitizeValue(analysis.name),
                'contact_status': sanitizeValue(analysis.contact_status),
                'contact_followuptime': sanitizeValue(analysis.contact_followuptime),
                'contact_followupdate': sanitizeValue(analysis.contact_followupdate),
                'User Type': sanitizeValue(analysis['User Type']),
                'city': sanitizeValue(analysis.city),
                'state': sanitizeValue(analysis.state),
                'Call Status': sanitizeValue(analysis['Call Status']),
                'Lead Status': sanitizeValue(analysis['Lead Status']),
                'lastUpdatedAt': new Date().toISOString(),
                'extra_param': extraParamString,
                'contact_comment': sanitizeValue(analysis.remark)
            };
            
            const callersRef = db.collection('callers');
            const snapshot = await callersRef.where('contact_num', '==', callerPhoneNumber).limit(1).get();

            if (snapshot.empty) {
                await callersRef.add({
                    ...fullCrmData,
                    createdAt: new Date().toISOString(),
                });
                console.log(`Successfully created new Firebase record for ${callerPhoneNumber}.`);
            } else {
                const callerDoc = snapshot.docs[0];
                await callerDoc.ref.update(fullCrmData);
                console.log(`Successfully updated Firebase record for ${callerPhoneNumber}.`);
            }
            
            await sendToExternalCRM(fullCrmData);

            return res.status(200).send();
        } catch (error) {
            console.error('End of call processing error:', error);
            return res.status(500).send();
        }
    }

    return res.status(200).send();
});

// --- ENHANCED BILINGUAL PROMPT FOR GEMINI ---
async function analyzeCallSummary(summary, transcript) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const prompt = `
    Analyze the following phone call transcript, which can be in English, Hindi, or a mix (Hinglish). Your task is to extract specific information into a JSON format.
    Your response MUST be a valid JSON object with ONLY the following English keys. If a value is not mentioned, use "Unknown".

    1.  "name": The full name of the caller (e.g., "Ashishwan"). In Hindi, this is "नाम".
    2.  "User Type": The role of the caller. Choose ONE: "Student", "Guardian", "Employee", "Garage Owner", "Unemployed", "Other". In Hindi, this is "उपयोगकर्ता प्रकार".
    3.  "course": The specific course the user is interested in. In Hindi, this is "कोर्स".
    4.  "city": The city the caller mentioned (e.g., "Delhi" or "दिल्ली"). In Hindi, this is "शहर".
    5.  "state": The state or country the caller mentioned (e.g., "Punjab" or "पंजाब"). In Hindi, this is "राज्य".
    6.  "Call Status": Choose ONE: "Connected-IB", "Connected-OB", "No Answer", "Switched off", "Out of service", "Not reachable", "Call disconnected by customer", "Busy", "Visited Center".
    7.  "Lead Status": Choose ONE: "Interested", "Not Interested", "Interested In Future", "Call Back", "Call Back In Evening", "Call Disconnected By Customer", "Booked", "Enquiry For Tools", "Enquiry For Job", "Enquiry For Franchise", "Busy", "Applicant Not Available".
    8.  "contact_status": This should be the SAME as the "Lead Status".
    9.  "contact_followupdate": Analyze phrases like 'call me in 2 days' or 'दो दिन बाद कॉल करना'. Today's date is ${new Date().toISOString().split('T')[0]}. Provide date in "YYYY-MM-DD" format or "N/A".
    10. "contact_followuptime": Analyze phrases like 'in the evening' or 'शाम को'. Provide a specific time like "2:00 PM" or a general time like "Morning", "Evening". If not mentioned, use "N/A".
    11. "remark": Generate a concise, one-sentence AI call summary of the conversation.

    Transcript: "${transcript}"
  `;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" }
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`API request failed with status ${response.status} and body: ${await response.text()}`);
    
    const data = await response.json();
    console.log("--- Gemini Analysis SUCCEEDED ---");
    return JSON.parse(data.candidates[0].content.parts[0].text);

  } catch (error) {
    console.error("Gemini analysis error:", error);
    return {
        'name': 'Unknown',
        'User Type': 'Unknown',
        'course': 'Unknown',
        'city': 'Unknown',
        'state': 'Unknown',
        'Call Status': 'Connected-IB',
        'Lead Status': 'Uncertain',
        'contact_status': 'Uncertain',
        'contact_followupdate': 'N/A',
        'contact_followuptime': 'N/A',
        'remark': `Gemini analysis failed: ${error.message}`
    };
  }
}

module.exports = app;
