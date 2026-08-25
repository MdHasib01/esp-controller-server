const { Router } = require('express');
const authRoutes = require('./auth.routes');
const devicesRoutes = require('./devices.routes');

const router = Router();

router.use('/auth', authRoutes);
router.use('/devices', devicesRoutes);

module.exports = router;
