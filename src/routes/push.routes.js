const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const pushController = require('../controllers/push.controller');

const router = Router();
router.use(requireAuth);

router.get('/public-key', asyncHandler(pushController.publicKey));
router.post('/subscribe', asyncHandler(pushController.subscribe));
router.post('/unsubscribe', asyncHandler(pushController.unsubscribe));
router.post('/test', asyncHandler(pushController.test));

module.exports = router;
