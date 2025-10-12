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

app.post('/api/handler', async (req, res) => {
    let parsedBody;
    try {
        if (typeof req.body === 'string' && req.body.length > 0) {
            parsedBody = JSON.parse(req.body);
        } else {
             console.warn("Received empty or non-string body. Skipping.");
             return res.status(200).send();
        }
    } catch (e) {
        console.warn("Received a request with a non-JSON body. Body:", req.body);
        return res.status(400).send('Invalid JSON');
    }
    
    const message = parsedBody.message || parsedBody;

    if (!message || !message.type) {
        console.warn("Could not find a valid message object with a 'type' property after parsing.", { parsedBody });
        return res.status(200).send();
    }

    if (message.type === 'tool-call' && message.toolCall.name === 'databasecheck') {
        const phoneNumber = getPhoneNumberFromMessage(message);
        if (!phoneNumber) {
             console.warn('Database check tool call with no phone number. Treating as new caller.');
             return res.status(200).json({ result: 'New caller' });
        }
        console.log(`Tool call received: databaseCheck for ${phoneNumber}`);
        try {
            const callersRef = db.collection('callers');
            const snapshot = await callersRef.where('phoneNumber', '==', phoneNumber).limit(1).get();
            if (snapshot.empty) {
                console.log(`New caller. Returning status.`);
                return res.status(200).json({ result: 'New caller' });
            } else {
                console.log(`Existing caller. Returning data.`);
                const callerData = snapshot.docs[0].data();
                const lastCall = callerData.callHistory[callerData.callHistory.length - 1] || {};
                const resultPayload = {
                    status: 'Existing caller',
                    name: callerData.name || 'Unknown',
                    lastCallSummary: lastCall.summary || 'No previous summary available.'
                };
                return res.status(200).json({ result: JSON.stringify(resultPayload) });
            }
        } catch (error) {
            console.error('Database check tool error:', error);
            return res.status(500).json({ result: 'Error checking database' });
        }
    }

    if (message.type === 'end-of-call-report') {
        console.log("--- RUNNING LATEST SERVER CODE v3.5 (Final Extraction Fix) ---");
        const callerPhoneNumber = getPhoneNumberFromMessage(message);

        if (!callerPhoneNumber) {
            console.warn('End-of-call report received with no parsable phone number. Skipping.');
            return res.status(200).send();
        }

        try {
            const summary = message?.analysis?.summary || message?.summary || 'No summary available.';
            const transcript = message?.artifact?.transcript || message?.transcript || '';
            const analysis = await analyzeCallSummary(summary, transcript);
            const newCallRecord = {
              date: new Date().toISOString(),
              summary,
              callStatus: analysis.callStatus,
              leadStatus: analysis.leadStatus,
              followupDate: analysis.followupDate,
              remark: analysis.remark,
              transcript,
            };

            const callersRef = db.collection('callers');
            const snapshot = await callersRef.where('phoneNumber', '==', callerPhoneNumber).limit(1).get();

            if (snapshot.empty) {
                const callerInfo = extractCallerInfo(transcript);
                await callersRef.add({
                    phoneNumber: callerPhoneNumber,
                    name: callerInfo.name,
                    course: callerInfo.course,
                    city: callerInfo.city,
                    state: callerInfo.state,
                    userType: callerInfo.userType,
                    createdAt: new Date().toISOString(),
                    callHistory: [newCallRecord]
                });
                console.log(`Successfully created new record for ${callerPhoneNumber}.`);
            } else {
                const callerDoc = snapshot.docs[0];
                const existingData = callerDoc.data();
                const updatedHistory = [...(existingData.callHistory || []), newCallRecord];
                await callerDoc.ref.update({ callHistory: updatedHistory });
                console.log(`Successfully updated record for ${callerPhoneNumber}.`);
            }
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
    1. "callStatus": Choose ONE: "Connected-IB", "Connected-OB", "No Answer", "Switched off", "Out of service", "Not reachable", "Call disconnected by customer", "Busy", "Visited Center"
    2. "leadStatus": Choose ONE: "Interested", "Not Interested", "Interested In Future", "Call Back", "Call Back In Evening", "Call Disconnected By Customer", "Booked", "Enquiry For Tools", "Enquiry For Job", "Enquiry For Franchise", "Busy", "Applicant Not Available"
    3. "followupDate": Analyze phrases like "call me in 2 days". Today's date is ${new Date().toISOString().split('T')[0]}. Provide date in "YYYY-MM-DD" format or "N/A".
    4. "remark": Generate a concise, one-sentence summary under 100 characters.
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
        callStatus: 'Connected-IB',
        leadStatus: 'Uncertain',
        followupDate: 'N/A',
        remark: `Gemini analysis failed: ${error.message}`
    };
  }
}

// --- FINAL, ROBUST VERSION of extractCallerInfo ---
function extractCallerInfo(transcript) {
    if (!transcript) {
        return { name: 'Unknown', course: 'Unknown', city: 'Unknown', state: 'Unknown', userType: 'Unknown' };
    }

    const info = { name: 'Unknown', course: 'Unknown', city: 'Unknown', state: 'Unknown', userType: 'Unknown' };

    // Split transcript by speaker for more accurate matching
    const userLines = transcript.split('\n').filter(line => line.startsWith('User:')).join('\n');

    // 1. Extract User Type (more robust)
    const userTypeRegex = /i am a (student|guardian|employee|garage owner|unemployed|other)|user: (student|guardian|employee|garage owner|unemployed|other)/i;
    const userTypeMatch = userLines.match(userTypeRegex);
    if (userTypeMatch) {
        info.userType = (userTypeMatch[1] || userTypeMatch[2]).charAt(0).toUpperCase() + (userTypeMatch[1] || userTypeMatch[2]).slice(1);
    }

    // 2. Extract Name (more robust)
    const nameRegex = /my name is ([\w\s]+?)(?=[.,]|\s*Um|\s*I'm|$)/i;
    const nameMatch = userLines.match(nameRegex);
    if (nameMatch) {
        info.name = nameMatch[1].trim();
    }

    // 3. Extract Course (more robust, looks for user's choice)
    const courseRegex = /interested in the ([\w\s+]+?)\s*course/i;
    const courseMatch = userLines.match(courseRegex);
    if (courseMatch) {
        info.course = courseMatch[1].trim();
    }
    
    // 4. Extract Location (looks for "City, Country" pattern or AI prompt)
    const cityStateRegex = /([\w\s]+),\s*([\w\s]+)/i;
    const cityStateMatch = userLines.match(cityStateRegex);
    if (cityStateMatch) {
        info.city = cityStateMatch[1].trim();
        info.state = cityStateMatch[2].trim();
    } else {
        // Fallback for just a city name mentioned by user
        const cityRegex = /user: ([\w\s]+)/i; // A simple capture of a location name
        const cityMatch = userLines.match(/located in ([\w\s]+)/i); // Look for phrases like "located in Nairobi"
        if(cityMatch) info.city = cityMatch[1].trim();
    }

    return info;
}


module.exports = app;
