# FIXED curl (single slash)
curl -X POST https://api.nexmo.com/v1/calls \
  -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBsaWNhdGlvbl9pZCI6ImY2NGM0N2YwLTIxNmUtNDVkOC1iZWE2LWE2ODQzNThmOTA5YiIsImlhdCI6MTc1ODM2NTk3NywiZXhwIjoxNzU4MzY2Mjc3LCJqdGkiOiJzdHQtMTc1ODM2NTk3NyJ9.cBoEkr75lOtSjgjaAJIGYTjfWzrxlm0ycYn7SVw7mSowpdJy4LCMsi03ajOv0qD-Do0rj0JuRdWlPFXo02PebLEjU85IZ5KTmUvSnEBpKRxynLczlj9aOg08nhlkHRB64yXRRnV-5P2QuE8-NaIpkH9YSDPlVVKIe2Fuengh5RxG1gKDXsUSdQQfLRLccxV3irELd2YxeinA8yd5ju2ffgP6_Xo0tSsHR_WuuKOIMlG-K-cYRWemWvEROMnJq-GYzWwMPxJQSaPB0J3GRh411UFG4MfNayvyYI1Lz3Ubre4WTSWF8TgbPqM2W8zqU9hLkJrA800F_5KR5pcaAu_5eA" \
  -H "Content-Type: application/json" \
  -d '{
    "to":   [{"type":"phone","number":"916283704791"}],
    "from": {"type":"phone","number":"14372662376"},
    "answer_url": ["https://3cc42d88f635.ngrok-free.app/api/voice/answer_ws"]
  }'
