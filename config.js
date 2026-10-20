// การตั้งค่าหน้าเว็บ แก้ไฟล์นี้ไฟล์เดียว
window.POLICE_MAP_CONFIG = {
  // ใส่ Google Maps JavaScript API key ที่นี่เพื่อใช้แผนที่ Google
  // ปล่อยว่างไว้ = ใช้แผนที่ OpenStreetMap (ไม่ต้องมี key)
  // ต้องจำกัด key ให้ใช้ได้เฉพาะโดเมน https://<user>.github.io/* ใน Google Cloud Console
  googleMapsApiKey: "",

  // จุดอ้างอิง (ตำรวจภูธรจังหวัดเชียงราย) ค่าจาก OpenStreetMap ถนนศูนย์ราชการ
  // ผู้ใช้แก้ได้ในหน้าเว็บ ค่านี้เป็นค่าเริ่มต้นเท่านั้น
  hq: {
    name: "ภ.จว.เชียงราย",
    lat: 19.930841,
    lng: 99.877192
  },

  // จุดที่ไกลจาก ภ.จว. เกินระยะนี้ (กม.) จะถูกเตือนว่าอาจกรอกผิด
  warnDistanceKm: 200
};
