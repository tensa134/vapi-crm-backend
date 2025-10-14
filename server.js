const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fetch = require('node-fetch');

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

// Updated to map to the new external CRM field names
async function sendToExternalCRM(data) {
    const url = 'https://indiavoice.rpdigitalphone.com/api_v2/savecontact_v2';
    const authcode = process.env.EXTERNAL_CRM_AUTHCODE;

    if (!authcode) {
        console.error('EXTERNAL_CRM_AUTHCODE is not set in environment variables. Skipping send.');
        return;
    }

    // Map our data to the new expected format of the external CRM
    const payload = {
        authcode: authcode,
        contact_num: data.contact_num,
        contact_name: data.contact_name,
        contact_status: data.contact_status,
        contact_followuptime: data.contact_followuptime,
        contact_followupdate: data.contact_followupdate,
        user_type: data['User Type'], // APIs often use snake_case
        city: data.city,
        state: data.state,
        call_status: data['Call Status'],
        lead_status: data['Lead Status'],
    };

    try {
        console.log('Sending data to external CRM with new format...');
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`External CRM API request failed with status ${response.status} and body: ${await response.text()}`);
        }

        const responseData = await response.json();
        console.log('Successfully sent data to external CRM. Response:', responseData);
    } catch (error)
    {
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
        const phoneNumber = getPhoneNumberFromMessage(message);
        if (!phoneNumber) {
             return res.status(200).json({ result: 'New caller' });
        }
        try {
            // Query using the new field name 'contact_num'
            const callersRef = db.collection('callers');
            const snapshot = await callersRef.where('contact_num', '==', phoneNumber).limit(1).get();
            if (snapshot.empty) {
                return res.status(200).json({ result: 'New caller' });
            } else {
                const callerData = snapshot.docs[0].data();
                const resultPayload = {
                    status: 'Existing caller',
                    name: callerData.contact_name || 'Unknown',
                    lastCallSummary: 'Previous call on record.'
                };
                return res.status(200).json({ result: JSON.stringify(resultPayload) });
            }
        } catch (error) {
            console.error('Database check tool error:', error);
            return res.status(500).json({ result: 'Error checking database' });
        }
    }

    if (message.type === 'end-of-call-report') {
        console.log("--- RUNNING LATEST SERVER CODE with New Data Structure ---");
        const callerPhoneNumber = getPhoneNumberFromMessage(message);

        if (!callerPhoneNumber) {
            return res.status(200).send();
        }

        try {
            const summary = message?.analysis?.summary || message?.summary || 'No summary available.';
            const transcript = message?.artifact?.transcript || message?.transcript || '';
            const analysis = await analyzeCallSummary(summary, transcript);
            const callerInfo = extractCallerInfo(transcript);

            // --- CONSTRUCT THE NEW FLAT DATA OBJECT ---
            const fullCrmData = {
                'contact_num': callerPhoneNumber,
                'contact_name': callerInfo.name,
                'contact_status': analysis.contact_status,
                'contact_followuptime': analysis.contact_followuptime,
                'contact_followupdate': analysis.contact_followupdate,
                'User Type': callerInfo.userType,
                'city': callerInfo.city,
                'state': callerInfo.state,
                'Call Status': analysis['Call Status'],
                'Lead Status': analysis['Lead Status'],
                // We'll also add createdAt and a lastUpdatedAt timestamp
                'lastUpdatedAt': new Date().toISOString()
            };
            
            const callersRef = db.collection('callers');
            const snapshot = await callersRef.where('contact_num', '==', callerPhoneNumber).limit(1).get();

            if (snapshot.empty) {
                // Create new document with the new structure
                await callersRef.add({
                    ...fullCrmData,
                    createdAt: new Date().toISOString(), // Add createdAt only on the first save
                });
                console.log(`Successfully created new Firebase record for ${callerPhoneNumber}.`);
            } else {
                // Update existing document with the new structure
                const callerDoc = snapshot.docs[0];
                await callerDoc.ref.update(fullCrmData);
                console.log(`Successfully updated Firebase record for ${callerPhoneNumber}.`);
            }
            
            // Call the function to send to the external CRM
            await sendToExternalCRM(fullCrmData);

            return res.status(200).send();
        } catch (error) {
            console.error('End of call processing error:', error);
            return res.status(500).send();
        }
    }

    return res.status(200).send();
});

async function analyzeCallSummary(summary, transcript) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const prompt = `
    Analyze the following phone call summary and transcript for "Justauto Solution Pvt. Ltd.".
    Your response MUST be a valid JSON object with ONLY the following keys. Adhere strictly to the provided values.
    1. "Call Status": Choose ONE: "Connected-IB", "Connected-OB", "No Answer", "Switched off", "Out of service", "Not reachable", "Call disconnected by customer", "Busy", "Visited Center"
    2. "Lead Status": Choose ONE: "Interested", "Not Interested", "Interested In Future", "Call Back", "Call Back In Evening", "Call Disconnected By Customer", "Booked", "Enquiry For Tools", "Enquiry For Job", "Enquiry For Franchise", "Busy", "Applicant Not Available"
    3. "contact_status": This should be the SAME as the "Lead Status".
    4. "contact_followupdate": Analyze phrases like 'call me in 2 days'. Today's date is ${new Date().toISOString().split('T')[0]}. Provide date in "YYYY-MM-DD" format or "N/A".
    5. "contact_followuptime": Analyze phrases like 'in the evening', 'around 2 pm', 'tomorrow morning'. Provide a specific time like "2:00 PM" or a general time like "Morning", "Evening". If not mentioned, use "N/A".
    Summary: "${summary}"
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
        'Call Status': 'Connected-IB',
        'Lead Status': 'Uncertain',
        'contact_status': 'Uncertain',
        'contact_followupdate': 'N/A',
        'contact_followuptime': 'N/A'
    };
  }
}

function extractCallerInfo(transcript) {
    if (!transcript) {
        return { name: 'Unknown', course: 'Unknown', city: 'Unknown', state: 'Unknown', userType: 'Unknown' };
    }
    const info = { name: 'Unknown', course: 'Unknown', city: 'Unknown', state: 'Unknown', userType: 'Unknown' };
    const userLines = transcript.split('\n').filter(line => line.startsWith('User:')).join('\n');
    const userTypeMatch = userLines.match(/\b(student|guardian|employee|garage owner|unemployed|other)\b/i);
    if (userTypeMatch) {
        info.userType = userTypeMatch[0].charAt(0).toUpperCase() + userTypeMatch[0].slice(1);
    }
    const nameMatch = userLines.match(/(?:my full name is|my name is)\s+([\w\s]+?)(?=\.|$)/i);
    if (nameMatch) {
        info.name = nameMatch[1].trim();
    }
    const courseMatch = userLines.match(/interested in the ([\w\s+]+?)\s*course/i);
    if (courseMatch) {
        info.course = courseMatch[1].trim();
    }
    const locationMatch = userLines.match(/(?:live in|in|from)\s+([\w\s]+?),\s*([\w\s]+?)(?=\.|$)/i);
    if (locationMatch) {
        info.city = locationMatch[1].trim();
        info.state = locationMatch[2].trim();
    }
    return info;
}

module.exports = app;
